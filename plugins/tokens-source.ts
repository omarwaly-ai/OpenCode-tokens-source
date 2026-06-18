// .opencode/plugins/tokens-source.ts
// Per-source token usage breakdown for opencode CLI.
//
// DESIGN PRINCIPLES (learned from the previous mess):
//   1. ONE source of truth per data point — no duplicate captures
//   2. ONE estimation function — used everywhere, no alternative paths
//   3. Debug log shows the SAME numbers the output uses — no conflicting calculations
//   4. NO fallback paths that produce different numbers
//   5. NO markdown, NO ANSI — plain text with Unicode bold only
//
// DATA FLOW (single direction, no loops):
//   config hook           → knownAgents (agent name + prompt + path)
//   system.transform hook → systemParts (system string array)
//   fetch wrapper         → payload (final HTTP body: systemText + messages + tools)
//   tool.execute hooks    → fileReads + toolOutputs (per-file / per-tool output tracking)
//   /tokens command       → reads ALL of the above, builds output ONCE
//
// Output: plain text. Bold via Unicode Mathematical Alphanumeric Symbols.
// Debug: /tokens --debug appends raw diagnostic data.

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"

// Bun is a global at runtime in opencode. Ambient type for VS Code.
declare const Bun: {
  writeFileSync(path: string, data: string): void
  file(path: string): { exists(): Promise<boolean> }
}

// ─── Token estimation ────────────────────────────────────────
// Single estimation function used everywhere. No alternatives.
const TOKEN_RATIO = 3.75
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / TOKEN_RATIO)
}

// ─── Unicode bold ────────────────────────────────────────────
// Converts text to Unicode Mathematical Alphanumeric Symbols (bold).
// A-Z → 𝐀-𝐙, a-z → 𝐚-𝐳, 0-9 → 𝟎-𝟗. Other chars preserved.
function bold(text: string): string {
  let out = ""
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 65 && c <= 90) out += String.fromCodePoint(0x1D400 + (c - 65))
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(0x1D41A + (c - 97))
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(0x1D7CE + (c - 48))
    else out += ch
  }
  return out
}

// ─── Path cleaning ───────────────────────────────────────────
// Strips user-home prefixes. Returns path from opencode anchor.
function cleanPath(rawPath: string): string {
  if (!rawPath) return ""
  let p = rawPath
  try { p = decodeURIComponent(new URL(p).pathname) } catch {}
  p = p.replace(/\\/g, "/")
  const anchors = ["/.config/opencode/", "/.opencode/", "/.claude/", "/.agents/"]
  for (const a of anchors) {
    const idx = p.lastIndexOf(a)
    if (idx >= 0) return p.slice(idx + 1)
  }
  const segs = p.split("/").filter(Boolean)
  if (segs.length >= 2) return segs[segs.length - 2] + "/" + segs[segs.length - 1]
  if (segs.length === 1) return segs[0]
  return p
}

// Built-in skill detection: opencode reports location as "<built-in>" or URL containing it.
function isBuiltinLocation(loc: string): boolean {
  if (!loc || loc === "<built-in>") return true
  try {
    const p = decodeURIComponent(new URL(loc).pathname)
    if (p.includes("<built-in>")) return true
  } catch {}
  return loc.includes("<built-in>")
}

// ─── Types ───────────────────────────────────────────────────
interface SourceItem {
  label: string       // display label (path or name)
  tokens: number      // estimated tokens
  chars: number       // raw char count
  category: "base" | "env" | "rules" | "builtin-skill" | "skill" | "tools" | "messages" | "other"
}

interface InterceptedPayload {
  url: string
  model: string
  sessionID: string
  systemText: string
  messages: { role: string; text: string }[]
  tools: { name: string; rawJson: string }[]
  rawBodyLength: number
}

// ─── State (single source per data type) ─────────────────────
const systemPartsBySession = new Map<string, string[]>()
const payloadBySession = new Map<string, InterceptedPayload>()
const knownAgents = new Map<string, { name: string; prompt: string; path: string }>()
const fileReads = new Map<string, { chars: number; tokens: number; reads: number; isInstruction: boolean }>()
const toolOutputs = new Map<string, { chars: number; tokens: number; count: number }>()
const pendingCalls = new Map<string, { tool: string; file?: string; args?: Record<string, any> }>()

// ─── Instruction file detection ──────────────────────────────
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md", ".agents.md", ".claude.md", "instructions.md"]
function isInstructionFile(filePath: string): boolean {
  const n = filePath.replace(/\\/g, "/")
  return INSTRUCTION_FILES.some(name => n.endsWith("/" + name) || n === name)
}

// ─── MCP tool detection ──────────────────────────────────────
function isMCPTool(name: string): boolean {
  return name.startsWith("mcp_") || name.startsWith("mcp__") || name.includes("__")
}

// ─── System text parser ──────────────────────────────────────
// Parses the joined system string into sections by markers.
// Returns SourceItems with NON-overlapping slices.
type ParsedSection = { label: string; start: number; end: number; path?: string; category: SourceItem["category"] }

function parseSystem(systemText: string): SourceItem[] {
  const s = systemText
  if (!s.trim()) return []
  const secs: ParsedSection[] = []

  // Environment: model marker
  const envModelIdx = s.indexOf("You are powered by the model named")
  const envTagIdx = s.indexOf("<env>")
  if (envModelIdx >= 0) {
    secs.push({ label: "model", start: envModelIdx, end: envTagIdx >= 0 ? envTagIdx : s.length, category: "env" })
  }
  if (envTagIdx >= 0) {
    const close = s.indexOf("</env>", envTagIdx)
    secs.push({ label: "cwd/git/platform", start: envTagIdx, end: close >= 0 ? close + 6 : s.length, category: "env" })
  }

  // Project rules: "Instructions from:" blocks
  const instrRe = /Instructions from:\s*([^\n]+)/g
  let m: RegExpExecArray | null
  const instrPositions: { path: string; start: number }[] = []
  while ((m = instrRe.exec(s)) !== null) {
    instrPositions.push({ path: m[1].trim(), start: m.index })
  }
  for (let i = 0; i < instrPositions.length; i++) {
    const next = i + 1 < instrPositions.length ? instrPositions[i + 1].start : nextMarker(s, instrPositions[i].start)
    secs.push({
      label: cleanPath(instrPositions[i].path),
      path: cleanPath(instrPositions[i].path),
      start: instrPositions[i].start,
      end: next,
      category: "rules",
    })
  }

  // Skills: <available_skills> block
  const skillsIdx = s.indexOf("Skills provide specialized instructions")
  if (skillsIdx >= 0) {
    const close = s.indexOf("</available_skills>", skillsIdx)
    const blockEnd = close >= 0 ? close + 19 : s.length
    const skillRe = /<skill>/g
    const skillEntries: { name: string; loc: string; start: number }[] = []
    let sm: RegExpExecArray | null
    while ((sm = skillRe.exec(s)) !== null) {
      if (sm.index < skillsIdx || sm.index >= blockEnd) continue
      const sc = s.indexOf("</skill>", sm.index)
      if (sc < 0) continue
      const block = s.slice(sm.index, sc + 8)
      const nm = block.match(/<name>([^<]+)<\/name>/)
      const lm = block.match(/<location>([^<]+)<\/location>/)
      skillEntries.push({
        name: nm ? nm[1].trim() : "unknown",
        loc: lm ? lm[1].trim() : "",
        start: sm.index,
      })
    }
    if (skillEntries.length > 0) {
      // Preamble (Skills header)
      const preambleEnd = skillEntries[0].start
      const preamble = s.slice(skillsIdx, preambleEnd).trim()
      if (preamble) {
        secs.push({ label: "Skills (header)", start: skillsIdx, end: preambleEnd, category: "skill" })
      }
      // Each skill
      for (let i = 0; i < skillEntries.length; i++) {
        const sc = s.indexOf("</skill>", skillEntries[i].start)
        const end = sc >= 0 ? sc + 8 : (i + 1 < skillEntries.length ? skillEntries[i + 1].start : blockEnd)
        const isBuiltin = isBuiltinLocation(skillEntries[i].loc)
        secs.push({
          label: isBuiltin ? skillEntries[i].name : cleanPath(skillEntries[i].loc),
          path: isBuiltin ? skillEntries[i].name : cleanPath(skillEntries[i].loc),
          start: skillEntries[i].start,
          end: end,
          category: isBuiltin ? "builtin-skill" : "skill",
        })
      }
      // Closing
      const lastEnd = secs[secs.length - 1].end
      if (lastEnd < blockEnd) {
        const closing = s.slice(lastEnd, blockEnd).trim()
        if (closing) secs.push({ label: "Skills (closing)", start: lastEnd, end: blockEnd, category: "skill" })
      }
    } else {
      secs.push({ label: "Skills", start: skillsIdx, end: blockEnd, category: "skill" })
    }
  }

  // Sort and fix overlaps
  secs.sort((a, b) => a.start - b.start)
  for (let i = 1; i < secs.length; i++) {
    if (secs[i].start < secs[i - 1].end) secs[i - 1].end = secs[i].start
  }

  // Build result: base prompt (text before first section) + all sections
  const result: SourceItem[] = []
  if (secs.length > 0 && secs[0].start > 0) {
    const base = s.slice(0, secs[0].start).trim()
    if (base) result.push({ label: "Base prompt", tokens: estimateTokens(base), chars: base.length, category: "base" })
  } else if (secs.length === 0) {
    const trimmed = s.trim()
    if (trimmed) result.push({ label: "Base prompt", tokens: estimateTokens(trimmed), chars: trimmed.length, category: "base" })
    return result
  }
  for (const sec of secs) {
    const content = s.slice(sec.start, sec.end).trim()
    if (content) result.push({ label: sec.label, tokens: estimateTokens(content), chars: content.length, category: sec.category })
  }
  return result
}

function nextMarker(s: string, after: number): number {
  const markers = ["Skills provide specialized instructions", "IMPORTANT: The user has requested structured output"]
  let nearest = s.length
  for (const mk of markers) {
    const idx = s.indexOf(mk, after + 1)
    if (idx > after && idx < nearest) nearest = idx
  }
  return nearest
}

// ─── Fetch wrapper ───────────────────────────────────────────
// Captures the FINAL HTTP body sent to the LLM. Single capture point.
let _originalFetch: typeof fetch | null = null
let _fetchWrapped = false
function wrapFetch(): void {
  if (_fetchWrapped) return
  _fetchWrapped = true
  _originalFetch = globalThis.fetch
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const isLLM = url.includes("/v1/chat/completions") || url.includes("/v1/messages") ||
      url.includes("api.deepseek.com") || url.includes("api.openai.com") ||
      url.includes("anthropic.com") || url.includes("openrouter.ai")
    if (!isLLM || !init?.body) return _originalFetch!.call(globalThis, input, init)

    let bodyText = ""
    try {
      if (typeof init.body === "string") bodyText = init.body
      else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) bodyText = new TextDecoder().decode(init.body)
      else if (init.body instanceof Blob) bodyText = await init.body.text()
      else if (init.body instanceof ReadableStream) return _originalFetch!.call(globalThis, input, init)
    } catch { return _originalFetch!.call(globalThis, input, init) }

    if (!bodyText) return _originalFetch!.call(globalThis, input, init)

    try {
      const body = JSON.parse(bodyText)
      // Extract sessionID from headers
      const h = init.headers
      const headers = h instanceof Headers ? h : Array.isArray(h) ? new Headers(h as any) : h ? new Headers(h as any) : new Headers()
      const sid = headers.get("x-opencode-session") || headers.get("x-session-id") || headers.get("X-Session-Id") || "__unknown__"

      let systemText = ""
      const messages: { role: string; text: string }[] = []
      const tools: { name: string; rawJson: string }[] = []

      if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")
          if (msg.role === "system") {
            systemText += (systemText ? "\n" : "") + content
          } else {
            messages.push({ role: msg.role, text: content })
          }
        }
      }
      if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
          const rawJson = JSON.stringify(tool)
          const name = tool.function?.name || tool.name || "unknown"
          tools.push({ name, rawJson })
        }
      }

      const payload: InterceptedPayload = {
        url, model: body.model || "unknown", sessionID: sid,
        systemText, messages, tools, rawBodyLength: bodyText.length,
      }
      payloadBySession.set(sid, payload)
    } catch {
      // Body wasn't valid JSON — skip
    }
    return _originalFetch!.call(globalThis, input, init)
  }
}

// ─── Plugin ──────────────────────────────────────────────────
const TokensSourcePlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { client, directory: projectDir } = input
  wrapFetch()
  return {
    // Capture system parts (array, before joining)
    "experimental.chat.system.transform": async (transformInput: any, output: any) => {
      const sid = transformInput.sessionID || "__global__"
      const parts = (output.system as string[]).filter(Boolean)
      if (parts.length) systemPartsBySession.set(sid, parts)
    },

    // Capture known agents at startup (NO LLM call)
    "config": async (cfg: any) => {
      knownAgents.clear()
      const agents = cfg?.agent
      if (!agents || typeof agents !== "object") return
      for (const [name, info] of Object.entries(agents)) {
        const a = info as any
        if (!a || typeof a.prompt !== "string" || !a.prompt.trim()) continue
        let path = `.config/opencode/agents/${name}.md`
        for (const candidate of [`${projectDir}/.opencode/agents/${name}.md`, `${projectDir}/.opencode/agent/${name}.md`]) {
          try { if (await Bun.file(candidate).exists()) { path = `.opencode/agents/${name}.md`; break } } catch {}
        }
        knownAgents.set(name, { name, prompt: a.prompt.trim(), path })
      }
    },

    // Track tool execution (for OTHER section)
    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      const tool = toolInput.tool as string | undefined
      const callID = toolInput.callID as string | undefined
      if (!tool || !callID) return
      const args = toolOutput.args || {}
      const file = args.file_path || args.path || undefined
      pendingCalls.set(callID, { tool, file, args: { ...args } })
      if (file && isInstructionFile(file)) {
        const ex = fileReads.get(file) || { chars: 0, tokens: 0, reads: 0, isInstruction: false }
        ex.isInstruction = true
        fileReads.set(file, ex)
      }
    },
    "tool.execute.after": async (toolInput: any, toolOutput: any) => {
      const tool = toolInput.tool as string | undefined
      const callID = toolInput.callID as string | undefined
      if (!tool || !callID) return
      const meta = pendingCalls.get(callID)
      pendingCalls.delete(callID)
      const output = String(toolOutput.output || toolOutput.title || "")
      const tokens = estimateTokens(output)
      if (tool === "read" && meta?.file) {
        const ex = fileReads.get(meta.file) || { chars: 0, tokens: 0, reads: 0, isInstruction: false }
        ex.chars += output.length
        ex.tokens += tokens
        ex.reads++
        if (isInstructionFile(meta.file)) ex.isInstruction = true
        fileReads.set(meta.file, ex)
      } else {
        const ex = toolOutputs.get(tool) || { chars: 0, tokens: 0, count: 0 }
        ex.chars += output.length
        ex.tokens += tokens
        ex.count++
        toolOutputs.set(tool, ex)
      }
    },

    // /tokens command
    "command.execute.before": async (cmdInput: any, cmdOutput: any) => {
      if (cmdInput.command !== "tokens") return
      // Clear the command's default output parts (from .opencode/commands/tokens.md)
      // so only the plugin's output shows — not the command file's content.
      if (cmdOutput && Array.isArray(cmdOutput.parts)) cmdOutput.parts.length = 0
      const debugEnabled = (cmdInput.arguments || "").trim() === "--debug"
      const sessionID = cmdInput.sessionID
      const sid = sessionID || "__global__"

      // ── Gather data ──
      const systemParts = systemPartsBySession.get(sid)
      const payload = payloadBySession.get(sid) || null

      // Parse system text into sections
      const systemText = systemParts ? systemParts.join("\n") : (payload?.systemText || "")
      let sources = parseSystem(systemText)

      // Agent attribution: match known agent prompt as prefix of systemText
      const agentItems: SourceItem[] = []
      if (systemText && knownAgents.size > 0) {
        for (const [name, agent] of knownAgents) {
          if (agent.prompt && systemText.startsWith(agent.prompt)) {
            const agentTokens = estimateTokens(agent.prompt)
            agentItems.push({ label: agent.path, tokens: agentTokens, chars: agent.prompt.length, category: "rules" })
            // Subtract from base prompt item
            const baseIdx = sources.findIndex(s => s.category === "base")
            if (baseIdx >= 0) {
              const base = sources[baseIdx]
              const restChars = Math.max(0, base.chars - agent.prompt.length)
              if (restChars > 0) {
                sources[baseIdx] = { ...base, tokens: Math.max(0, base.tokens - agentTokens), chars: restChars }
              } else {
                sources.splice(baseIdx, 1)
              }
            }
            break
          }
        }
      }

      // Group by category
      const baseItems = sources.filter(s => s.category === "base")
      const envItems = sources.filter(s => s.category === "env")
      const rulesItems = sources.filter(s => s.category === "rules").concat(agentItems)
      const builtinItems = sources.filter(s => s.category === "builtin-skill")
      const skillItems = sources.filter(s => s.category === "skill")
      const toolItems: SourceItem[] = payload ? payload.tools.map(t => ({
        label: t.name, tokens: estimateTokens(t.rawJson), chars: t.rawJson.length, category: "tools",
      })) : []
      const msgItems: SourceItem[] = payload ? payload.messages.map(m => ({
        label: m.role, tokens: estimateTokens(m.text), chars: m.text.length, category: "messages",
      })) : []
      // File reads + tool outputs → other
      const otherItems: SourceItem[] = []
      for (const [file, data] of fileReads) {
        const base = cleanPath(file)
        otherItems.push({
          label: (data.isInstruction ? base + " [AGENTS]" : base) + " x" + data.reads,
          tokens: data.tokens, chars: data.chars, category: "other",
        })
      }
      for (const [tool, data] of toolOutputs) {
        otherItems.push({
          label: tool + " (" + data.count + ")" + (isMCPTool(tool) ? " [MCP]" : ""),
          tokens: data.tokens, chars: data.chars, category: "other",
        })
      }

      // ── Build output lines ──
      // Compute GLOBAL column widths across ALL sections (unified layout).
      const allItems = baseItems.concat(envItems, rulesItems, builtinItems, skillItems, toolItems, msgItems, otherItems)
      const allLabels = allItems.map(i => "  " + i.label)
      const allVals = allItems.map(i => i.tokens.toLocaleString())
      const W_LABEL = Math.max(...allLabels.map(l => l.length), "TOTAL".length)
      const W_VALUE = Math.max(...allVals.map(v => v.length), "0".length)
      const W_GAP = 2

      const lines: string[] = []
      lines.push("TOKEN SOURCE TRACKING")
      lines.push("-".repeat(W_LABEL + W_GAP + W_VALUE))
      if (payload) {
        lines.push("model: " + payload.model)
        lines.push("url: " + payload.url)
      }
      lines.push("")

      // Helper: render a section using GLOBAL column widths
      // showTotal: only SKILLS and TOOLS get a TOTAL line
      function renderSection(title: string, items: SourceItem[], showTotal: boolean) {
        if (items.length === 0) return
        lines.push(title)
        for (const item of items) {
          const lbl = "  " + item.label
          const val = item.tokens.toLocaleString()
          lines.push(lbl.padEnd(W_LABEL) + " ".repeat(W_GAP) + val.padStart(W_VALUE))
        }
        if (showTotal) {
          const total = items.reduce((s, x) => s + x.tokens, 0)
          lines.push(bold("TOTAL".padEnd(W_LABEL) + " ".repeat(W_GAP) + total.toLocaleString().padStart(W_VALUE)))
        }
        lines.push("")
      }

      renderSection("BASE PROMPT", baseItems, false)
      renderSection("ENVIRONMENT", envItems, false)
      renderSection("PROJECT RULES", rulesItems, false)
      renderSection("BUILT-IN SKILLS", builtinItems, false)
      renderSection("SKILLS", skillItems, true)
      renderSection("TOOLS", toolItems, true)
      renderSection("MESSAGES", msgItems, false)
      renderSection("OTHER", otherItems.sort((a, b) => b.tokens - a.tokens), false)

      // Grand total — NOT displayed. Only used internally if needed.
      // (kept for potential future use but not shown in output)
      const _grandTotal = baseItems.concat(envItems, rulesItems, builtinItems, skillItems, toolItems, msgItems, otherItems)
        .reduce((s, x) => s + x.tokens, 0)
      lines.push("========================================")
      lines.push("for debugging run /tokens --debug")

      // ── Debug section ──
      if (debugEnabled) {
        lines.push("")
        lines.push("DEBUG RAW DATA")
        lines.push("-".repeat(60))
        lines.push("session_id: " + sid)
        lines.push("systemParts_count: " + (systemParts?.length ?? 0))
        lines.push("systemText_chars: " + systemText.length)
        lines.push("systemText_tokens: " + estimateTokens(systemText))
        lines.push("payload_exists: " + (!!payload))
        if (payload) {
          lines.push("payload_url: " + payload.url)
          lines.push("payload_model: " + payload.model)
          lines.push("payload_sessionID: " + payload.sessionID)
          lines.push("payload_systemText_chars: " + payload.systemText.length)
          lines.push("payload_messages_count: " + payload.messages.length)
          lines.push("payload_messages_chars: " + payload.messages.reduce((s, m) => s + m.text.length, 0))
          lines.push("payload_tools_count: " + payload.tools.length)
          lines.push("payload_tools_chars: " + payload.tools.reduce((s, t) => s + t.rawJson.length, 0))
          lines.push("payload_rawBody_chars: " + payload.rawBodyLength)
          for (let i = 0; i < payload.messages.length; i++) {
            const m = payload.messages[i]
            lines.push("  msg[" + i + "]: role=" + m.role + " chars=" + m.text.length + " tokens=" + estimateTokens(m.text) + " first50=" + JSON.stringify(m.text.slice(0, 50)))
          }
          for (let i = 0; i < payload.tools.length; i++) {
            const t = payload.tools[i]
            lines.push("  tool[" + i + "]: name=" + t.name + " chars=" + t.rawJson.length + " tokens=" + estimateTokens(t.rawJson))
          }
        }
        lines.push("knownAgents_count: " + knownAgents.size)
        for (const [name, agent] of knownAgents) {
          lines.push("  agent: name=" + name + " prompt_chars=" + agent.prompt.length + " prompt_tokens=" + estimateTokens(agent.prompt) + " path=" + agent.path)
        }
        lines.push("fileReads_count: " + fileReads.size)
        lines.push("toolOutputs_count: " + toolOutputs.size)
        lines.push("grandTotal: " + _grandTotal)
        lines.push("-".repeat(60))
      }

      // ── Send output ──
      const text = lines.join("\n")
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: { noReply: true, parts: [{ type: "text", text }] },
        })
      } catch {}
      Promise.resolve().then(async () => {
        try { await client.session.abort({ path: { id: sessionID } }) } catch {}
      })
    },
  }
}
export default TokensSourcePlugin

