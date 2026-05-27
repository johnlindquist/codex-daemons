#!/usr/bin/env bun
/**
 * Interactive profile generator.
 * Usage: bun create.ts
 */

const rl = await import("readline");
const { writeFileSync, chmodSync } = await import("fs");
const { join } = await import("path");

function ask(question: string): Promise<string> {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    iface.question(question, (answer: string) => {
      iface.close();
      resolve(answer.trim());
    });
  });
}

console.log("🔧 Codex Profile Generator\n");

const toolName = await ask("CLI tool name (e.g. docker, kubectl, fly): ");
const profileName = await ask(`Profile name (default: ${toolName.slice(0, 3)}s): `) || `${toolName.slice(0, 3)}s`;
const description = await ask(`One-line description (e.g. "container management"): `);
const helpCmd = await ask(`Help command (default: ${toolName} --help): `) || `${toolName} --help`;

let extraRules = "";
console.log("\nEnter tool-specific rules (one per line, empty line to finish):");
const ruleIface = rl.createInterface({ input: process.stdin, output: process.stdout });
for await (const line of ruleIface) {
  if (!line.trim()) break;
  extraRules += `- ${line.trim()}\n`;
}
ruleIface.close();

const content = `#!/usr/bin/env bun
import { runProfile } from "../lib/isolated.ts";
import { execSync } from "child_process";

let toolHelp: string;
try {
  toolHelp = execSync("${helpCmd} 2>&1", { encoding: "utf-8", timeout: 5000 });
} catch {
  toolHelp = "(${toolName} --help unavailable)";
}

runProfile({
  name: "${profileName}",
  baseInstructions: "You are ${profileName}, a ${description} agent. Only use ${toolName}.",
  developerInstructions: \`You are ${profileName}, a fast ${description} agent.

Your ONLY job is to run ${toolName} commands to fulfill the user's request.

## Rules
- Use \\\`${toolName}\\\` commands via exec_command.
${extraRules || `- Follow ${toolName} best practices.\n`}- Be terse. Report what you did, not what you plan to do.
- Do NOT browse the web, generate images, or search tools.
- Do NOT use apply_patch or write files unless the user explicitly asks.

## ${toolName} CLI reference

\\\`\\\`\\\`
\${toolHelp}
\\\`\\\`\\\`\`,
});
`;

const outPath = join(import.meta.dir, "profiles", profileName);
writeFileSync(outPath, content);
chmodSync(outPath, 0o755);

console.log(`\n✅ Created ${outPath}`);
console.log(`\nNext steps:`);
console.log(`  1. Review and customize: $EDITOR ${outPath}`);
console.log(`  2. Test: bun ${outPath} --help`);
console.log(`  3. Test: bun ${outPath} "your first prompt"`);
console.log(`  4. Add to package.json bin and reinstall: bun install -g .`);
