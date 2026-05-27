/**
 * Shared helper for creating fully isolated Codex SDK agents.
 *
 * Handles CODEX_HOME isolation, auth symlink, and the full set of
 * feature flags that minimize token usage (~6K vs ~22K default).
 *
 * Source references (from codex-rs source investigation):
 *   features.apps          codex-rs/features/src/lib.rs:130     (saves ~14K tokens)
 *   features.image_gen     codex-rs/features/src/lib.rs:168
 *   features.tool_search   codex-rs/features/src/lib.rs:136
 *   features.tool_suggest  codex-rs/features/src/lib.rs:140
 *   skills.include_instructions  codex-rs/core/src/config/mod.rs:3184
 *   include_apps_instructions    codex-rs/core/src/config/mod.rs:592
 *   include_environment_context  codex-rs/core/src/config/mod.rs:601
 *   base_instructions            codex-rs/core/src/session/mod.rs:550
 *   web_search                   codex-rs/core/src/config/mod.rs:2130
 */

import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { mkdirSync, symlinkSync, existsSync, rmSync } from "fs";
import { execSync } from "child_process";

export interface ProfileConfig {
  name: string;
  model?: string;
  reasoningEffort?: string;
  baseInstructions: string;
  developerInstructions: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  extraEnv?: Record<string, string>;
}

export function createIsolatedCodex(config: ProfileConfig) {
  const realHome = process.env.HOME!;
  const isolatedHome = `/tmp/codex-profile-${config.name}-${process.pid}`;
  mkdirSync(isolatedHome, { recursive: true });

  const authSrc = `${realHome}/.codex/auth.json`;
  const authDst = `${isolatedHome}/auth.json`;
  if (existsSync(authSrc) && !existsSync(authDst)) {
    symlinkSync(authSrc, authDst);
  }

  const model = config.model || process.env.CODEX_PROFILE_MODEL || "gpt-5.3-codex-spark";

  const codex = new Codex({
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: realHome,
      CODEX_HOME: isolatedHome,
      ...config.extraEnv,
    },
    config: {
      base_instructions: config.baseInstructions,
      developer_instructions: config.developerInstructions,
      model_reasoning_effort: config.reasoningEffort || "low",

      skills: { include_instructions: false },
      include_apps_instructions: false,
      include_environment_context: false,
      include_collaboration_mode_instructions: false,
      include_permissions_instructions: false,

      project_doc_max_bytes: 0,
      memories: { use_memories: false },
      mcp_servers: {},
      web_search: "disabled",

      features: {
        plugins: false,
        hooks: false,
        memories: false,
        apps: false,
        image_generation: false,
        tool_search: false,
        tool_suggest: false,
      },
    },
  });

  const startThread = (overrides?: Partial<ThreadOptions>) =>
    codex.startThread({
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: config.sandboxMode || "danger-full-access",
      approvalPolicy: "never",
      ...overrides,
    });

  const cleanup = () => {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {}
  };

  return { codex, startThread, cleanup, model, isolatedHome };
}

// CLI isolation flags for -i (interactive TUI) mode
export function buildInteractiveFlags(config: ProfileConfig): string[] {
  const model = config.model || process.env.CODEX_PROFILE_MODEL || "gpt-5.3-codex-spark";
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "--disable", "plugins",
    "--disable", "hooks",
    "--disable", "memories",
    "--disable", "apps",
    "--disable", "image_generation",
    "--disable", "tool_search",
    "--disable", "tool_suggest",
    "-c", "skills.include_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_environment_context=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_permissions_instructions=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "memories.use_memories=false",
    "-c", "mcp_servers={}",
    "-c", 'web_search="disabled"',
    "-c", `model_reasoning_effort="${config.reasoningEffort || "low"}"`,
    "-m", model,
  ];
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const interactive = args.includes("-i") || args.includes("--interactive");
  const streaming = args.includes("--stream");
  const help = args.includes("--help") || args.includes("-h");
  const prompt = args
    .filter((a) => !["--stream", "-i", "--interactive", "--help", "-h"].includes(a))
    .join(" ");
  return { interactive, streaming, help, prompt, noArgs: args.length === 0 };
}

export async function runProfile(config: ProfileConfig) {
  const { interactive, streaming, help, prompt, noArgs } = parseArgs(process.argv);

  if (help || noArgs) {
    console.log(`${config.name} — isolated codex agent (spark)

Usage:
  ${config.name} <prompt>            One-shot command
  ${config.name} --stream <prompt>   Stream events
  ${config.name} -i [prompt]         Interactive TUI in new cmux pane
  ${config.name} --help              Show this help`);
    process.exit(0);
  }

  if (interactive) {
    const devInstructions = tomlEscape(config.developerInstructions);
    const flags = buildInteractiveFlags(config);

    const launcherPath = `/tmp/${config.name}-launcher-${process.pid}.sh`;
    const { writeFileSync } = await import("fs");
    const launcherContent = [
      "#!/bin/sh",
      `cd ${JSON.stringify(process.cwd())}`,
      [
        "exec codex",
        ...flags.map((f) => JSON.stringify(f)),
        "-c", `'developer_instructions="${devInstructions}"'`,
        "--skip-git-repo-check",
      ].join(" "),
    ].join("\n");
    writeFileSync(launcherPath, launcherContent, { mode: 0o755 });

    try {
      const result = execSync("cmux new-pane --focus true", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const match = result.match(/surface:(\d+)/);
      const surfaceRef = match ? `surface:${match[1]}` : undefined;
      if (surfaceRef) {
        execSync(`cmux send --surface ${surfaceRef} "${launcherPath}\n"`, {
          encoding: "utf-8",
          timeout: 5000,
        });
        console.log(`Opened interactive codex in ${surfaceRef}`);
      } else {
        console.error("Failed to parse cmux surface ref from:", result);
        process.exit(1);
      }
    } catch (e: any) {
      console.error("Failed to open cmux pane:", e.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!prompt) {
    console.error(`${config.name}: no prompt provided (use -i for interactive mode)`);
    process.exit(1);
  }

  const { startThread, cleanup } = createIsolatedCodex(config);
  const thread = startThread();

  try {
    if (streaming) {
      const { events } = await thread.runStreamed(prompt);
      for await (const event of events) {
        if (event.type === "item.completed") {
          const item = event.item;
          if (item.type === "agent_message") console.log(item.text);
          else if (item.type === "command_execution" && item.exit_code !== 0) {
            console.error(`$ ${item.command} → exit ${item.exit_code}`);
            if (item.aggregated_output) console.error(item.aggregated_output);
          }
        }
      }
    } else {
      const turn = await thread.run(prompt);
      for (const item of turn.items) {
        if (item.type === "command_execution" && item.aggregated_output) {
          process.stderr.write(item.aggregated_output);
        }
      }
      if (turn.finalResponse) console.log(turn.finalResponse);
    }
  } finally {
    cleanup();
  }
}
