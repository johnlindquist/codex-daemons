# codex-profiles

Single-purpose, isolated [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) agents for common CLI tools. Each profile runs with ~6K input tokens instead of the default ~22K — faster, cheaper, and focused.

## What is a profile?

A profile is a single executable TypeScript file that wraps a CLI tool with an isolated Codex agent. It:

- Loads **zero** user-space config (no plugins, skills, hooks, memories, or MCP servers)
- Replaces the ~20K system prompt with a focused tool-specific prompt
- Disables unused tool schemas (Gmail, Slack, web, imagegen) via feature flags
- Symlinks only `auth.json` for login — token refreshes propagate automatically
- Uses `gpt-5.3-codex-spark` with `low` reasoning effort for maximum speed

## Install

```bash
# Requires bun (https://bun.sh) and @openai/codex CLI (authenticated)
git clone https://github.com/johnlindquist/codex-profiles
cd codex-profiles
bun install
bun link
```

This installs dependencies and symlinks all profiles to `~/.bun/bin/` (which should be on your PATH if bun is installed). You can also run profiles directly without linking:

```bash
bun profiles/ghs "list my open PRs"
```

## Profiles

| Command | Tool | Description |
|---------|------|-------------|
| `cxs` | [cmux](https://github.com/manaflow-ai/cmux) | Terminal workspace automation |
| `ghs` | [gh](https://cli.github.com) | GitHub CLI (issues, PRs, releases, actions) |
| `kbs` | [goku](https://github.com/yqrashawn/GokuRakuJoTu) | Karabiner-Elements config (karabiner.edn) |
| `pxs` | [packx](https://www.npmjs.com/package/packx) | AI context bundling |
| `bms` | [basic-memory](https://github.com/basicmachines-co/basic-memory) | Knowledge management |
| `bds` | [bird](https://www.npmjs.com/package/bird) | Twitter/X CLI |
| `abs` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Browser automation |
| `codex-minimal` | — | Bare template for building your own |

## Usage

Every profile supports the same flags:

```bash
# One-shot (default)
ghs "list my open PRs"

# Stream events as they happen
ghs --stream "create an issue titled 'fix login bug'"

# Interactive TUI in a new cmux pane
ghs -i

# Help
ghs --help
```

## Create your own

### Option A: Interactive generator

```bash
bun run create
# or after global install:
codex-create-profile
```

### Option B: Copy-paste prompt

See [docs/PROMPT.md](docs/PROMPT.md) — paste it into any AI agent with your tool's `--help` output.

### Option C: Copy the template

```bash
cp profiles/minimal profiles/my-tool
chmod +x profiles/my-tool
# Edit and customize
```

## How isolation works

Each profile creates a temporary `CODEX_HOME` with only a symlinked `auth.json`. Combined with feature flags, this strips ~16K tokens of overhead:

| What's disabled | Tokens saved | Config key |
|---|---|---|
| Server-side apps (Gmail, Slack, DeepWiki) | ~14,000 | `features.apps = false` |
| Image generation | ~1,000 | `features.image_generation = false` |
| Web search | ~1,000 | `web_search = "disabled"` |
| Tool discovery | ~500 | `features.tool_search = false` |
| Model system prompt | ~5,000 | `base_instructions` override |
| Skills, plugins, hooks, memories | varies | Feature flags |

See [docs/ISOLATION.md](docs/ISOLATION.md) for the full research with source line references.

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Codex CLI](https://www.npmjs.com/package/@openai/codex) (authenticated — `codex auth login`)
- The CLI tool each profile wraps (e.g. `gh`, `bird`, `cmux`)
