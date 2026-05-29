/**
 * Shared runtime helpers for self-improving daemons.
 *
 * A profile opts in with `selfImprove: { enabled: true }`. When enabled, the
 * daemon's isolated CODEX_HOME gets a Codex lifecycle-hook config wired up so a
 * Stop hook can inspect the finished turn and append "lessons" to an overlay
 * file. The daemon loads that overlay into its developerInstructions at startup
 * (applyLessonOverlay), and lib/daemon.ts::sourceFingerprint() hashes the
 * overlay — so the next prompt hot-reloads the daemon with the new guidance.
 *
 * Hook trust: these daemons are non-interactive and own a throwaway CODEX_HOME,
 * so we set `bypass_hook_trust = true` + `features.hooks = true`. Only `command`
 * handlers run in the bundled Codex build (async/prompt/agent are skipped).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { ProfileConfig } from "./isolated.ts";

export interface SelfImproveConfig {
  /** Opt in to the Stop-hook self-improvement loop. */
  enabled?: boolean;
  /** Override the lessons overlay file path (default: `<executable>.lessons.md`). */
  lessonsPath?: string;
}

export interface PreparedCodexHome {
  /** Env vars to merge into the spawned Codex process (and thus visible to hooks). */
  extraEnv: Record<string, string>;
  hooksEnabled: boolean;
  lessonsPath?: string;
}

const LESSONS_HEADING = "## Self-improvement lessons";

export function hooksEnabled(config: ProfileConfig): boolean {
  return config.selfImprove?.enabled === true;
}

/** Absolute path to the profile executable currently running (argv[1]). */
export function profileSelfPath(): string {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

/** `<repo>/lib` relative to the profile executable (`<repo>/daemons/pro-X`). */
export function profileLibDir(selfPath = profileSelfPath()): string {
  return join(dirname(selfPath), "..", "lib");
}

export function defaultLessonsPath(selfPath = profileSelfPath()): string {
  return `${selfPath}.lessons.md`;
}

export function lessonsPathFor(config: ProfileConfig): string | undefined {
  if (!hooksEnabled(config)) return undefined;
  return config.selfImprove?.lessonsPath || defaultLessonsPath();
}

/**
 * If a lessons overlay exists and is non-empty, append it to the profile's
 * developerInstructions under a stable heading. Idempotent: re-applying is a
 * no-op once the heading is present.
 */
export function applyLessonOverlay(config: ProfileConfig): ProfileConfig {
  const lessonsPath = lessonsPathFor(config);
  if (!lessonsPath || !existsSync(lessonsPath)) return config;
  const lessons = readFileSync(lessonsPath, "utf8").trim();
  if (!lessons) return config;
  if (config.developerInstructions.includes(LESSONS_HEADING)) return config;
  return {
    ...config,
    developerInstructions: `${config.developerInstructions}

${LESSONS_HEADING}
These lessons were written by this daemon's Stop hook after prior failed turns. Treat them as operating guidance; do not mention them unless asked.

${lessons}`,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prepare an isolated CODEX_HOME: symlink auth, and (when self-improvement is
 * enabled) write config.toml + hooks.json wiring up the Stop/SessionStart
 * command hook. Returns env vars to inject into the Codex process so the hook
 * knows its own nature: name, executable path, lib dir, and lessons file.
 */
export function prepareIsolatedCodexHome(
  config: ProfileConfig,
  isolatedHome: string,
  realHome = process.env.HOME!,
): PreparedCodexHome {
  mkdirSync(isolatedHome, { recursive: true });

  const authSrc = `${realHome}/.codex/auth.json`;
  const authDst = `${isolatedHome}/auth.json`;
  if (existsSync(authSrc) && !existsSync(authDst)) {
    symlinkSync(authSrc, authDst);
  }

  const selfPath = profileSelfPath();
  const libDir = profileLibDir(selfPath);
  const lessonsPath = lessonsPathFor(config);

  const extraEnv: Record<string, string> = {
    CODEX_DAEMON_NAME: config.name,
    CODEX_DAEMON_SELF_PATH: selfPath,
    CODEX_DAEMON_LIB_DIR: libDir,
  };
  if (lessonsPath) extraEnv.CODEX_DAEMON_LESSONS_PATH = lessonsPath;
  // Opt-in observability: propagate the debug flag so the Stop hook records what
  // it received (event, transcript_path, failures) to `<lessons>.debug.jsonl`.
  if (process.env.CODEX_SELF_IMPROVE_DEBUG) extraEnv.CODEX_SELF_IMPROVE_DEBUG = process.env.CODEX_SELF_IMPROVE_DEBUG;

  if (!hooksEnabled(config)) {
    return { extraEnv, hooksEnabled: false, lessonsPath };
  }

  // Seed an empty overlay so applyLessonOverlay has a stable path to read and
  // sourceFingerprint() has a file to hash from the first run.
  if (lessonsPath && !existsSync(lessonsPath)) {
    mkdirSync(dirname(lessonsPath), { recursive: true });
    writeFileSync(lessonsPath, "", "utf8");
  }

  // Copy the Stop handler into the isolated home so the run is self-contained
  // and snapshots the handler version this daemon started with.
  const hooksDir = join(isolatedHome, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const handlerSrc = join(libDir, "self-improve-stop.ts");
  const handlerDst = join(hooksDir, "self-improve-stop.ts");
  copyFileSync(handlerSrc, handlerDst);
  chmodSync(handlerDst, 0o755);

  writeFileSync(
    join(isolatedHome, "config.toml"),
    ["# Generated by codex-daemons for this self-improving profile.", "bypass_hook_trust = true", "", "[features]", "hooks = true", ""].join("\n"),
    "utf8",
  );

  const command = `bun ${shellQuote(handlerDst)}`;
  writeFileSync(
    join(isolatedHome, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command, timeout: 10, statusMessage: "self-improve: scan turn for failures" },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return { extraEnv, hooksEnabled: true, lessonsPath };
}
