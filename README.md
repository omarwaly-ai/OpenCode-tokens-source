<p align="center">
 <img width="150" height="150" alt="OpenCode Tokens Source Plugin" src="https://github.com/user-attachments/assets/fb3bba12-7d2b-4f83-9ea2-8b58f327255f" />
</p>
<div align="center">

# Opencode Tokens Source Plugin

**Per-source token usage breakdown for [opencode](https://opencode.ai)**

See what's consuming your context window — broken down by source.

[![opencode](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Overview

`opencode-tokens-source` is a plugin for [opencode](https://opencode.ai) that shows a detailed breakdown of **what was injected into your LLM request** — by source.

**Zero LLM calls. Zero dependencies. Zero tokenizers.** The plugin passively observes your existing LLM requests — it never triggers additional API calls, never installs npm packages, and never bundles a tokenizer. It's lightweight, self-contained, and production-ready.

**Use cases:**
- 📊 **Understand your context budget** — see which sources eat the most tokens
- 🔍 **Debug unexpected token usage** — identify bloated tool definitions, verbose skills, or large AGENTS.md files
- ⚡ **Optimize your setup** — trim unnecessary skills or consolidate tools to save context. For automatic tool loading on demand (saves 6k+ tokens), check out the [Opencode Lazy Loading plugin](https://github.com/omarwaly-ai/opencode-lazy-loading)
- 🧪 **Verify agent configuration** — confirm your custom agent's prompt was loaded correctly

---
## Opencode tokens source Output

| Section | Description |
|---|---|
| **BASE PROMPT** | opencode's built-in default system prompt. Only appears when using the default agent — custom agents replace it. |
| **ENVIRONMENT** | Model name, working directory, git status, platform info. |
| **PROJECT RULES** | `AGENTS.md` files + custom agent `.md` files from `.opencode/agents/`. |
| **BUILT-IN SKILLS** | Skills shipped with opencode (e.g., `customize-opencode`). Shown by name only — no disk path. |
| **SKILLS** | Disk-discovered skills from `.opencode/skills/*/SKILL.md`. Full paths shown. |
| **TOOLS** | Tool definitions (JSON schemas) sent to the LLM. Sorted by token count, descending. |
| **MESSAGES** | User and assistant messages in the conversation. |

### Path Display Format

| Source Type | Display Format |
|---|---|
| Project agent | `.opencode/agents/<name>.md` |
| Global agent | `.config/opencode/agents/<name>.md` |
| Project rules (AGENTS.md) | `<dir>/AGENTS.md` (from opencode anchor) |
| Built-in skill | Name only (e.g., `customize-opencode`) |
| Disk skill | `.opencode/skills/<dir>/SKILL.md` |
| Other files | Full path from opencode anchor, with extension |

---

## Installation

### Prerequisites

- [opencode](https://opencode.ai) v1.14 or later
- An existing opencode project (a directory with a `.opencode/` folder)

### Quick Install (Git Clone)

#### macOS / Linux

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/opencode-tokens-source.git

# Copy both files into your project
cd your-project
cp ../opencode-tokens-source/plugins/tokens-source.ts .opencode/plugins/
cp ../opencode-tokens-source/commands/tokens.md .opencode/commands/
```

#### Windows (PowerShell)

```powershell
# Clone the repo
git clone https://github.com/YOUR_USERNAME/opencode-tokens-source.git

# Copy both files into your project
cd your-project
Copy-Item ..\opencode-tokens-source\plugins\tokens-source.ts .opencode\plugins\
Copy-Item ..\opencode-tokens-source\commands\tokens.md .opencode\commands\
```

### Manual Install (No Git)

#### macOS / Linux

```bash
cd your-project
mkdir -p .opencode/plugins .opencode/commands

curl -sL https://raw.githubusercontent.com/YOUR_USERNAME/opencode-tokens-source/main/plugins/tokens-source.ts \
  -o .opencode/plugins/tokens-source.ts

curl -sL https://raw.githubusercontent.com/YOUR_USERNAME/opencode-tokens-source/main/commands/tokens.md \
  -o .opencode/commands/tokens.md
```

#### Windows (PowerShell)

```powershell
cd your-project
New-Item -ItemType Directory -Force -Path .opencode\plugins, .opencode\commands

Invoke-WebRequest "https://raw.githubusercontent.com/YOUR_USERNAME/opencode-tokens-source/main/plugins/tokens-source.ts" `
  -OutFile .opencode\plugins\tokens-source.ts

Invoke-WebRequest "https://raw.githubusercontent.com/YOUR_USERNAME/opencode-tokens-source/main/commands/tokens.md" `
  -OutFile .opencode\commands\tokens.md
```

### Verify

1. **Restart opencode** (close and reopen)
2. Send any message (e.g., `hi`) — this triggers the hooks to capture data
3. Run `/tokens`
4. You should see the token source tracking report

> **Note:** The plugin requires two files:
> - `.opencode/plugins/tokens-source.ts` — the plugin logic
> - `.opencode/commands/tokens.md` — the command stub that registers `/tokens`

---

## Usage

### `/tokens`

Shows the per-source token breakdown for the current session's last LLM call.

### `/tokens --debug`

Shows the normal report **plus** a DEBUG RAW DATA section with raw diagnostic data.
Use this when investigating discrepancies, filing bug reports, or developing the plugin.

---

## How It Works

The plugin uses three opencode plugin hooks — **no LLM calls are triggered** by the plugin:

| Hook | Purpose | When It Fires |
|---|---|---|
| `config` | Captures all known agents (name + prompt + path) | At opencode startup |
| `experimental.chat.system.transform` | Captures the system prompt parts array | During your normal LLM call |
| `command.execute.before` | Handles `/tokens` — reads captured data, builds report | When you type `/tokens` |

A fetch wrapper passively intercepts the actual HTTP body sent to the LLM provider, capturing system text, messages, and tool definitions from the real request.

The plugin does NOT:
- ❌ Trigger LLM calls
- ❌ Scan your disk for files
- ❌ Require npm dependencies


---

## Limitations

### Token Counts Are Estimates

Per-section token counts are **estimates** based on character count, not exact tokenizer output. The plugin does not bundle a tokenizer.

**Why?** Tokenizers are model-specific (GPT, Claude, DeepSeek each use different BPE vocabularies). Bundling one adds 2–4 MB of dependencies. The plugin's goal is **source attribution** — showing which content consumed tokens — not billing accuracy.

**Expected variance:** The grand total may differ from your provider's reported input tokens by **5–12%**, depending on content type:
- JSON-heavy content (tool definitions) tends to over-estimate
- Plain English prose is closer to actual
- Per-section **relative proportions** are reliable even when absolute numbers differ

For exact token counts, check your provider's API usage dashboard.

### Agent Path Detection

The `config` hook provides agent names and prompts but not file paths. The plugin determines whether an agent is project-level (`.opencode/agents/`) or global (`.config/opencode/agents/`) via a single file-existence check per agent. This is not disk scanning — agents are already discovered by opencode.

### Built-in Skills Have No Disk Path

Skills like `customize-opencode` are compiled into the opencode binary at build time. There is no file on disk. The plugin shows the skill **name only** — no fabricated path.

---

## Repository Structure

```
opencode-tokens-source/
├── plugins/
│   └── tokens-source.ts      # The plugin (copy to .opencode/plugins/)
├── commands/
│   └── tokens.md             # The command stub (copy to .opencode/commands/)
├── README.md
├── LICENSE
└── .gitignore
```



## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

