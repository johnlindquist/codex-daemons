# Codex SDK Isolation Reference

How to build fully isolated Codex agents with minimal token overhead.

Discovered by reverse-engineering the Codex CLI source (`codex-rs/`) and testing each config key's impact on input token count.

## Token Budget

| Configuration | Input tokens |
|---|---|
| Default (full user config) | ~22,000 |
| + `CODEX_HOME` override | ~21,500 |
| + `features.apps=false` (**saves ~14K**) | ~8,650 |
| + disable imagegen, tool_search, tool_suggest, web | ~5,665 (CLI) / ~6,161 (SDK) |
| + `--disable shell_tool` (no commands) | ~5,225 |

## Architecture

The system prompt is **built client-side**, not server-injected:

1. **`base_instructions`** — ~20K chars fetched from OpenAI's model endpoint, cached in `~/.codex/models_cache.json`. Fully replaceable via config.
2. **Developer messages** — skill instructions, environment context, permissions, apps. All toggleable.
3. **Tool schemas** — the tool definitions sent to the Responses API. Controlled by feature flags.

## Config Keys

### Instructions (developer message sections)

| Key | Source | Effect |
|---|---|---|
| `base_instructions` | `session/mod.rs:550` | Replaces the entire ~20K char model system prompt |
| `developer_instructions` | `config/mod.rs:580` | Custom developer message (separate from base) |
| `skills.include_instructions` | `config/mod.rs:3184` | Skill definitions in prompt |
| `include_apps_instructions` | `config/mod.rs:592` | Apps instruction text |
| `include_environment_context` | `config/mod.rs:601` | OS/shell/cwd context |
| `include_collaboration_mode_instructions` | `config/mod.rs:595` | Collaboration mode rules |
| `include_permissions_instructions` | `config/mod.rs:589` | Permission/approval instructions |
| `project_doc_max_bytes` | config | Max bytes of AGENTS.md/project docs |
| `memories.use_memories` | config | Load/inject memories |
| `mcp_servers` | config | MCP server connections |

### Feature Flags (tool schema control)

| Flag | Source | Tokens saved |
|---|---|---|
| `features.apps` | `features/src/lib.rs:130` | **~14,000** (Gmail, Slack, DeepWiki, web, imagegen schemas) |
| `features.image_generation` | `features/src/lib.rs:168` | ~1,000 |
| `features.tool_search` | `features/src/lib.rs:136` | ~500 |
| `features.tool_suggest` | `features/src/lib.rs:140` | ~200 |
| `web_search` | `config/mod.rs:2130` | ~1,000 |
| `features.plugins` | `features/src/lib.rs:142` | Varies |
| `features.hooks` | `features/src/lib.rs:82` | Varies |
| `features.memories` | `features/src/lib.rs:114` | Varies |

### CLI-only flags (not in SDK)

| Flag | SDK Workaround |
|---|---|
| `--ignore-user-config` | `CODEX_HOME` → empty dir via `env` |
| `--ignore-rules` | Empty `CODEX_HOME` (no rules to load) |
| `--ephemeral` | Disposable `CODEX_HOME` dir (saves ~496 tokens) |
| `--disable <feature>` | `config.features.name = false` |

## Auth Isolation

Symlink `auth.json` from the real `CODEX_HOME` — token refreshes propagate automatically:

```typescript
symlinkSync(`${HOME}/.codex/auth.json`, `${isolatedHome}/auth.json`);
```

## Irreducible Floor (~5K tokens)

Even with everything disabled, these core tool schemas remain:
- `functions.exec_command`, `functions.apply_patch`, `functions.update_plan`
- `functions.view_image`, `functions.request_user_input`, `functions.write_stdin`
- `multi_tool_use.parallel`

PR [#14525](https://github.com/openai/codex/pull/14525) proposed per-tool granular control but was closed without merging.
