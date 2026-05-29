#!/usr/bin/env bun
/**
 * Self-improvement engine + Codex Stop hook handler.
 *
 * The pure functions here (scanTranscript / walk / recordLessons / lessonFor)
 * detect failed tool/command calls and append a deterministic "lesson" to the
 * daemon's lessons overlay file. The daemon reads that overlay into its
 * developerInstructions at startup, and lib/daemon.ts::sourceFingerprint()
 * hashes it — so the NEXT prompt hot-reloads the daemon with the new guidance.
 *
 * TWO triggers feed the same recordLessons():
 *   1. DAEMON-SIDE (active, default): lib/appserver.ts watches the turn stream
 *      for non-zero command exits and calls recordLessons() at turn end. This is
 *      what works today, because the shipped Codex build (0.134/0.135) does NOT
 *      execute user-config lifecycle hooks for non-interactive exec/app-server
 *      turns (run_stop is dispatched but discovery returns no handlers).
 *   2. CODEX STOP HOOK (forward-compatible): when invoked directly as a Stop hook
 *      (`bun self-improve-stop.ts` with the hook JSON on stdin), main() scans the
 *      rollout `transcript_path`. Wired up in lib/codex-runtime.ts for builds
 *      where Codex runs these hooks.
 *
 * Stop hook contract (codex-rs): stdin = Stop input JSON
 *   { hook_event_name, transcript_path, stop_hook_active, ... };
 *   stdout = { "continue": true } (output suppressed — plain text becomes model context).
 *
 * FAILS OPEN: any error still prints {continue:true} so a broken self-improvement
 * step can never break the user's turn.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

export interface Failure {
  kind: "nonzero-exit" | "failed-status" | "error-field";
  path: string;
  exit?: number;
  status?: string;
  command?: string;
  message?: string;
}

const FAILED_STATES = new Set(["failed", "error", "errored"]);
const EXIT_KEYS = new Set(["exit_code", "exitcode", "exit_status", "exitstatus"]);

function trunc(value: unknown, max = 300): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Find the first non-empty string under any of `keys`, searching recursively. */
function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const child of Object.values(obj)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

/** Recursively collect failure signals from one parsed rollout record. */
export function walk(value: unknown, path = "$", out: Failure[] = []): Failure[] {
  if (!value || typeof value !== "object") return out;
  const obj = value as Record<string, unknown>;
  const command = findString(obj, ["command", "cmd"]);
  const message =
    findString(obj, ["stderr", "stdout", "aggregated_output", "formatted_output", "message", "error"]) ||
    undefined;

  for (const [key, child] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (EXIT_KEYS.has(lower) && typeof child === "number" && child !== 0) {
      out.push({ kind: "nonzero-exit", path: `${path}.${key}`, exit: child, command, message });
    }
    if (
      (lower === "status" || lower === "state") &&
      typeof child === "string" &&
      FAILED_STATES.has(child.toLowerCase())
    ) {
      out.push({ kind: "failed-status", path: `${path}.${key}`, status: child, command, message });
    }
    if (lower === "error" && child) {
      const text = trunc(child, 300);
      if (text && text !== "null" && text !== "undefined" && text !== "{}") {
        out.push({ kind: "error-field", path: `${path}.${key}`, command, message: text });
      }
    }
    if (child && typeof child === "object") walk(child, `${path}.${key}`, out);
  }
  return out;
}

/** Scan a rollout JSONL transcript and return all detected failures. */
export function scanTranscript(jsonl: string): Failure[] {
  const failures: Failure[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      walk(JSON.parse(line), "$", failures);
    } catch {
      // Ignore malformed/partial lines.
    }
  }
  return failures;
}

/** Stable short signature for a failure, used to dedupe lessons across turns. */
export function signature(failure: Failure): string {
  return createHash("sha256")
    .update([failure.kind, failure.exit ?? "", failure.status ?? "", failure.command ?? "", failure.message ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Render a markdown lesson block (with a hidden dedupe marker) for one failure. */
export function lessonFor(failure: Failure): string {
  const marker = `<!-- selfimprove:${signature(failure)} -->`;
  const command = failure.command ? ` Command: \`${trunc(failure.command, 160)}\`.` : "";
  const exit = failure.exit !== undefined ? ` Exit: ${failure.exit}.` : "";
  const status = failure.status ? ` Status: ${failure.status}.` : "";
  const msg = failure.message ? ` Evidence: ${trunc(failure.message, 220)}` : "";
  return [
    "",
    marker,
    `- A previous turn produced a failed tool/command result.${command}${exit}${status} Next time, read the failure output before retrying; if syntax is uncertain, run the narrow \`--help\`/discovery command first, then retry once with corrected syntax.${msg}`,
    "",
  ].join("\n");
}

/**
 * Append lessons for any NEW failures (by signature) to the lessons file.
 * Returns the number of lessons written. Pure enough to unit-test directly.
 */
export function recordLessons(lessonsPath: string, failures: Failure[], max = 3): number {
  if (failures.length === 0) return 0;
  mkdirSync(dirname(lessonsPath), { recursive: true });
  const existing = existsSync(lessonsPath) ? readFileSync(lessonsPath, "utf8") : "";
  let written = 0;
  const seen = new Set<string>();
  for (const failure of failures) {
    if (written >= max) break;
    const sig = signature(failure);
    if (seen.has(sig) || existing.includes(`selfimprove:${sig}`)) continue;
    seen.add(sig);
    appendFileSync(lessonsPath, lessonFor(failure), "utf8");
    written++;
  }
  return written;
}

function ok(): void {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
}

/** CLI entry: only runs when invoked directly, not when imported by tests. */
async function main(): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    const input = raw.trim() ? JSON.parse(raw) : {};

    // Only act on Stop; never on SessionStart or other events.
    if (input.hook_event_name !== "Stop") return ok();
    // Recursion guards: don't self-improve from inside a stop-hook continuation
    // or from a self-improvement sub-run.
    if (input.stop_hook_active || process.env.CODEX_SELF_IMPROVE_SKIP === "1") return ok();

    const lessonsPath = process.env.CODEX_DAEMON_LESSONS_PATH;
    const transcriptPath = input.transcript_path;
    if (!lessonsPath || typeof lessonsPath !== "string") return ok();

    const debug = process.env.CODEX_SELF_IMPROVE_DEBUG === "1";
    const dbg = (obj: Record<string, unknown>) => {
      if (!debug) return;
      try {
        mkdirSync(dirname(lessonsPath), { recursive: true });
        appendFileSync(`${lessonsPath}.debug.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n");
      } catch {}
    };

    if (!transcriptPath || typeof transcriptPath !== "string" || !existsSync(transcriptPath)) {
      dbg({ event: input.hook_event_name, transcript_path: transcriptPath ?? null, transcript_exists: false });
      return ok();
    }

    const failures = scanTranscript(readFileSync(transcriptPath, "utf8"));
    const written = recordLessons(lessonsPath, failures);
    dbg({ event: input.hook_event_name, transcript_path: transcriptPath, transcript_exists: true, failures: failures.length, lessons_written: written });
    return ok();
  } catch {
    // Fail open: a broken self-improvement step must not break the user's turn.
    return ok();
  }
}

if (import.meta.main) {
  await main();
}
