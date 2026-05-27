# Create Your Own Codex Profile

Copy this prompt into any AI agent (Claude, Codex, ChatGPT) to generate a new profile for your CLI tool.

---

## The Prompt

```
I want to create a Codex profile — a single-purpose, isolated Codex SDK agent
that wraps a specific CLI tool. The profile should:

1. Be a single executable TypeScript file with #!/usr/bin/env bun shebang
2. Import { runProfile } from "../lib/isolated.ts" (or inline the isolation code)
3. Capture the CLI tool's --help output at startup
4. Define clear base_instructions (one-line identity) and developer_instructions
   (detailed rules + CLI reference)

Here's the template:

#!/usr/bin/env bun
import { runProfile } from "../lib/isolated.ts";
import { execSync } from "child_process";

let toolHelp: string;
try {
  toolHelp = execSync("TOOL_NAME --help 2>&1", { encoding: "utf-8", timeout: 5000 });
} catch {
  toolHelp = "(TOOL_NAME --help unavailable)";
}

runProfile({
  name: "PROFILE_NAME",
  baseInstructions: "You are PROFILE_NAME, a TOOL_DESCRIPTION agent. Only use TOOL_NAME.",
  developerInstructions: `You are PROFILE_NAME, a fast TOOL_DESCRIPTION agent.

Your ONLY job is to run TOOL_NAME commands to fulfill the user's request.

## Rules
- Use \`TOOL_NAME\` commands via exec_command.
- TOOL_SPECIFIC_RULES
- Be terse. Report what you did, not what you plan to do.
- Do NOT browse the web, generate images, or search tools.
- Do NOT use apply_patch or write files unless the user explicitly asks.

## TOOL_NAME CLI reference

\`\`\`
${toolHelp}
\`\`\``,
});

---

My CLI tool is: [DESCRIBE YOUR TOOL]

The tool's --help output is:
[PASTE --help OUTPUT]

Please generate the complete profile file with:
- A short, specific name (3 letters + "s" suffix, like "ghs" for GitHub)
- base_instructions that scope the agent to ONLY this tool
- developer_instructions with:
  - Common command patterns organized by task
  - Rules about output format preferences
  - Anything the agent should NOT do
- Any extra env vars the tool needs passed through
```

---

## Tips

- **Name convention**: 3 letters + "s" suffix (e.g., `ghs`, `bds`, `pxs`)
- **Keep rules strict**: The agent should refuse to do anything outside the tool's scope
- **Include CLI reference**: Capturing `--help` at startup means the agent always has current docs
- **Extra env vars**: If your tool needs specific env vars (API keys, config paths), pass them via `extraEnv`

## After generating

1. Save the file to `profiles/` in this repo (or anywhere on your PATH)
2. `chmod +x profiles/your-profile`
3. Test: `your-profile --help` then `your-profile "do something"`
4. If using this repo: add to `package.json` bin field and reinstall
