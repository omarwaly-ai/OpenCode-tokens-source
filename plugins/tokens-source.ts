// .opencode/plugin/tokens-source.ts
// Token usage breakdown by source for opencode CLI
// Hooks: experimental.chat.system.transform + experimental.chat.messages.transform
//        + tool.definition + command.execute.before

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { Schema as EffectSchema } from "effect"

// ─── Types ───────────────────────────────────────────────────────────────────

interface SourceBreakdown {
  label: string
  chars: number
  tokens: number
}

interface ToolBreakdown {
  id: string
  tokens: number
}

interface MsgBreakdown {
  role: string
  parts: { type: string; chars: number; tokens: number }[]
  totalChars: number
  totalTokens: number
}

interface TokenSnapshot {
  sources: SourceBreakdown[]
  totalSystemChars: number
  totalSystemTokens: number
  timestamp: number
}

interface MsgSnapshot {
  messages: MsgBreakdown[]
  totalChars: number
  totalTokens: number
  timestamp: number
}

// ─── State ───────────────────────────────────────────────────────────────────

const globalTools: ToolBreakdown[] = []
const snapshots = new Map<string, TokenSnapshot>()
const msgSnapshots = new Map<string, MsgSnapshot>()

// ─── Token estimation ─────────────────────────────────────────────────────────

function est(charCount: number): number {
  return Math.ceil(charCount / 4)
}

// ─── Convert Effect Schema to JSON Schema ────────────────────────────────────
//
// The `tool.definition` hook provides `output.parameters` as an Effect Schema
// AST object (with `~effect/Schema` symbols). Stringifying it directly gives
// ~6x inflated sizes because it includes AST metadata, annotations, etc.
//
// We use Effect's `Schema.toJsonSchemaDocument()` to convert it to the real
// JSON Schema that the LLM API actually receives. This is the correct API
// in Effect 4.0.0-beta.83 (bundled with opencode 1.17.10).
//
// Note: `Schema.toStandardJSONSchemaV1()` exists but returns an EMPTY jsonSchema
// object in this version — it only adds a `~standard` wrapper without computing
// the actual schema. `toJsonSchemaDocument()` is the working API.

function effectToJSONSchema(effectSchema: any): any | null {
  if (!effectSchema) return null

  // Preferred: toJsonSchemaDocument (works in Effect 4.0.0-beta.83)
  try {
    const doc = EffectSchema.toJsonSchemaDocument(effectSchema)
    if (doc && (doc as any).schema) {
      return (doc as any).schema
    }
    if (doc && typeof doc === "object") return doc
  } catch {
    // Fall through
  }

  // Fallback: toStandardJSONSchemaV1 (older Effect versions)
  try {
    const result = EffectSchema.toStandardJSONSchemaV1(effectSchema)
    const standard = result?.["~standard"]
    if (standard?.jsonSchema && Object.keys(standard.jsonSchema).length > 0) {
      return standard.jsonSchema
    }
  } catch {
    // Fall through
  }

  // Final fallback: manual conversion
  try {
    return manualConvert(effectSchema)
  } catch {
    return null
  }
}

function manualConvert(node: any): any {
  if (!node || typeof node !== "object") return {}
  // Effect Schema struct: {"fields": {...}}
  if (node.fields) {
    const props: Record<string, any> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(node.fields)) {
      const converted = manualConvert(val)
      props[key] = converted
      // Check if optional (has "schema" wrapper with "_tag" Optional)
      const isOptional = (val as any)?.schema?._tag === "Optional" ||
                         JSON.stringify(val).includes('"_tag":"Optional"')
      if (!isOptional) required.push(key)
    }
    const result: any = { type: "object", properties: props }
    if (required.length > 0) result.required = required
    return result
  }
  // Direct AST node: {"ast": {"_tag": "String", "annotations": {...}}}
  if (node.ast) {
    return manualConvert(node.ast)
  }
  // Type node: {"_tag": "String", "annotations": {"description": "..."}}
  if (node._tag) {
    const typeMap: Record<string, string> = {
      String: "string", Number: "number", Boolean: "boolean",
      Int: "integer", BigInt: "number",
    }
    const result: any = {}
    if (typeMap[node._tag]) result.type = typeMap[node._tag]
    if (node.annotations?.description) result.description = node.annotations.description
    return result
  }
  // Optional wrapper: {"schema": {"value": {...}}}
  if (node.schema?.value) {
    return manualConvert(node.schema.value)
  }
  return {}
}

// ─── Shorten a file path ──────────────────────────────────────────────────────
// Show last 2 meaningful path segments so you can tell files apart.

function shortPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/")

  if (normalized.startsWith(".") || normalized.startsWith("~")) return normalized

  const anchors = [".opencode", ".claude", ".agents", ".config"]
  for (const anchor of anchors) {
    const idx = normalized.lastIndexOf("/" + anchor + "/")
    if (idx >= 0) {
      const fromAnchor = normalized.slice(idx + 1)
      const segs = fromAnchor.split("/")
      return segs.length > 3 ? segs.slice(0, 3).join("/") + "/..." : fromAnchor
    }
  }

  const segs = normalized.split("/").filter(Boolean)
  if (segs.length >= 2) return segs[segs.length - 2] + "/" + segs[segs.length - 1]
  if (segs.length === 1) return segs[0]
  return raw
}

// ─── Skill label from <location> tag ──────────────────────────────────────────

function skillLabel(name: string, location: string): string {
  if (!location || location === "<built-in>") return name

  let filePath: string
  try {
    filePath = decodeURIComponent(new URL(location).pathname)
  } catch {
    filePath = location
  }

  filePath = filePath.replace(/\\/g, "/")

  const anchors = [
    "/.config/opencode/skills/",
    "/.opencode/skills/",
    "/.claude/skills/",
    "/.agents/skills/",
  ]

  for (const pattern of anchors) {
    const idx = filePath.lastIndexOf(pattern)
    if (idx >= 0) {
      const after = filePath.slice(idx + pattern.length)
      const match = after.match(/^([^/]+)/)
      const skillDir = match ? match[1] : name
      return pattern.slice(1) + skillDir
    }
  }

  return name
}

// ─── Parse system array into per-source breakdowns ───────────────────────────

function parseSystemArray(parts: string[]): SourceBreakdown[] {
  if (!parts.length) return []
  const result: SourceBreakdown[] = []

  const core = parts[0] || ""
  if (core.trim()) {
    result.push(...parseCoreBlob(core))
  }

  for (let i = 1; i < parts.length; i++) {
    const txt = parts[i].trim()
    if (!txt) continue
    const firstLine = txt.split("\n")[0].slice(0, 60)
    result.push({ label: `plugin[${i}]: ${firstLine}`, chars: txt.length, tokens: est(txt.length) })
  }

  return result
}

function parseCoreBlob(s: string): SourceBreakdown[] {
  const trimmed = s.trim()
  if (!trimmed) return []

  type Sec = { label: string; start: number; end: number }
  const secs: Sec[] = []

  const envModelIdx = s.indexOf("You are powered by the model named")
  const envTagIdx   = s.indexOf("<env>")
  if (envModelIdx >= 0) {
    secs.push({
      label: "Environment (model)",
      start: envModelIdx,
      end: envTagIdx >= 0 ? envTagIdx : s.length,
    })
  }

  if (envTagIdx >= 0) {
    const envCloseIdx = s.indexOf("</env>", envTagIdx)
    secs.push({
      label: "Environment (cwd/git/platform)",
      start: envTagIdx,
      end: envCloseIdx >= 0 ? envCloseIdx + 6 : s.length,
    })
  }

  const refOpenIdx = s.indexOf("<available_references>")
  if (refOpenIdx >= 0) {
    const refCloseIdx = s.indexOf("</available_references>", refOpenIdx)
    const preambleIdx = s.lastIndexOf("Project references", refOpenIdx)
    secs.push({
      label: "Environment (references)",
      start: preambleIdx >= 0 ? preambleIdx : refOpenIdx,
      end: refCloseIdx >= 0 ? refCloseIdx + 23 : s.length,
    })
  }

  const instrRe = /Instructions from:\s*([^\n]+)/g
  let instrMatch: RegExpExecArray | null
  const instrPositions: { path: string; start: number }[] = []
  while ((instrMatch = instrRe.exec(s)) !== null) {
    instrPositions.push({
      path: instrMatch[1].trim(),
      start: instrMatch.index,
    })
  }
  for (let i = 0; i < instrPositions.length; i++) {
    const nextStart =
      i + 1 < instrPositions.length
        ? instrPositions[i + 1].start
        : nextMajorMarkerAfter(s, instrPositions[i].start)
    secs.push({
      label: shortPath(instrPositions[i].path),
      start: instrPositions[i].start,
      end: nextStart,
    })
  }

  const skillsIdx = s.indexOf("Skills provide specialized instructions")
  if (skillsIdx >= 0) {
    const skillsCloseIdx    = s.indexOf("</available_skills>", skillsIdx)
    const structAfterSkills = s.indexOf("IMPORTANT: The user has requested structured output", skillsIdx)
    const skillsBlockEnd    = skillsCloseIdx >= 0 ? skillsCloseIdx + 19 : s.length
    const skillsBlockRealEnd = structAfterSkills >= 0 && structAfterSkills < skillsBlockEnd ? structAfterSkills : skillsBlockEnd

    const skillOpenRe = /<skill>/g
    const skillEntries: { label: string; start: number }[] = []
    let skillOpenMatch: RegExpExecArray | null
    while ((skillOpenMatch = skillOpenRe.exec(s)) !== null) {
      if (skillOpenMatch.index < skillsIdx || skillOpenMatch.index >= skillsBlockRealEnd) continue
      const skillStart = skillOpenMatch.index
      const skillCloseIdx = s.indexOf("</skill>", skillStart)
      if (skillCloseIdx < 0) continue
      const skillBlock = s.slice(skillStart, skillCloseIdx + 8)
      const nameMatch = skillBlock.match(/<name>([^<]+)<\/name>/)
      const name = nameMatch ? nameMatch[1].trim() : "unknown"
      const locMatch = skillBlock.match(/<location>([^<]+)<\/location>/)
      const loc = locMatch ? locMatch[1].trim() : ""
      const label = skillLabel(name, loc)
      skillEntries.push({ label, start: skillStart })
    }

    if (skillEntries.length > 0) {
      const preambleEnd = skillEntries[0].start
      const preamble = s.slice(skillsIdx, preambleEnd).trim()
      if (preamble) {
        secs.push({ label: "Skills (header)", start: skillsIdx, end: preambleEnd })
      }

      for (let i = 0; i < skillEntries.length; i++) {
        const skillCloseIdx = s.indexOf("</skill>", skillEntries[i].start)
        const skillEntryEnd = skillCloseIdx >= 0 ? skillCloseIdx + 8 : (i + 1 < skillEntries.length ? skillEntries[i + 1].start : skillsBlockRealEnd)
        secs.push({
          label: skillEntries[i].label,
          start: skillEntries[i].start,
          end: skillEntryEnd,
        })
      }

      const lastSkillEnd = secs[secs.length - 1].end
      if (lastSkillEnd < skillsBlockRealEnd) {
        const closing = s.slice(lastSkillEnd, skillsBlockRealEnd).trim()
        if (closing) {
          secs.push({ label: "Skills (closing)", start: lastSkillEnd, end: skillsBlockRealEnd })
        }
      }
    } else {
      secs.push({ label: "Skills", start: skillsIdx, end: skillsBlockRealEnd })
    }
  }

  const structStart = s.indexOf("IMPORTANT: The user has requested structured output")
  if (structStart >= 0) {
    secs.push({ label: "Structured output", start: structStart, end: s.length })
  }

  secs.sort((a, b) => a.start - b.start)
  for (let i = 1; i < secs.length; i++) {
    if (secs[i].start < secs[i - 1].end) {
      secs[i - 1].end = secs[i].start
    }
  }

  const result: SourceBreakdown[] = []

  if (secs.length > 0 && secs[0].start > 0) {
    const base = s.slice(0, secs[0].start).trim()
    if (base) {
      result.push({ label: "Base prompt", chars: base.length, tokens: est(base.length) })
    }
  } else if (secs.length === 0) {
    result.push({ label: "Base prompt", chars: trimmed.length, tokens: est(trimmed.length) })
    return result
  }

  for (const sec of secs) {
    const content = s.slice(sec.start, sec.end).trim()
    if (content) {
      result.push({ label: sec.label, chars: content.length, tokens: est(content.length) })
    }
  }

  const measuredChars = result.reduce((sum, r) => sum + r.chars, 0)
  const gapChars = trimmed.length - measuredChars
  if (gapChars > 10) {
    result.push({ label: "Whitespace", chars: gapChars, tokens: est(gapChars) })
  }

  return result
}

function nextMajorMarkerAfter(s: string, after: number): number {
  const markers = [
    "Skills provide specialized instructions",
    "IMPORTANT: The user has requested structured output",
  ]
  let nearest = s.length
  for (const m of markers) {
    const idx = s.indexOf(m, after + 1)
    if (idx > after && idx < nearest) nearest = idx
  }
  return nearest
}

// ─── Count chars in a part AUTOMATICALLY ──────────────────────────────────────
// No hardcoded type checks — stringify whatever the part contains.

function partChars(p: any): number {
  if (!p) return 0
  // text parts: count the text directly
  if (typeof p.text === "string" && p.text.length > 0) return p.text.length
  // everything else: JSON.stringify the whole object
  try {
    return JSON.stringify(p).length
  } catch {
    return 0
  }
}

function partTypeLabel(p: any): string {
  if (!p) return "?"
  if (p.type === "text" || (typeof p.text === "string" && (!p.type || p.type === "text"))) return "text"
  if (p.type === "tool-invocation") {
    const toolName = p.toolInvocation?.toolName || p.toolInvocation?.name || ""
    return "tool-call:" + toolName
  }
  if (p.type === "tool-result") {
    const toolName = p.toolName || p.toolInvocation?.toolName || ""
    return "tool-result:" + toolName
  }
  // Any other type — just use the type field
  return p.type || "unknown"
}


// ─── Fetch wrapper — captures REAL tools sent to the LLM ─────────────────────
//
// This plugin loads BEFORE opencode-lazy-load (filename `0-tokens-source.ts`
// sorts before `opencode-lazy-load.ts` alphabetically). This makes tokens-source
// the INNER fetch wrapper, and lazy-load the OUTER wrapper.
//
// When the LLM is called:
//   1. lazy-load's wrapper (outer) runs first — strips all tools except load_tool,
//      appends pointer list to load_tool's description
//   2. lazy-load calls _originalFetch → tokens-source's wrapper (inner) runs
//   3. tokens-source sees the FINAL body (just load_tool with pointers) and
//      captures it
//   4. tokens-source calls _originalFetch → real fetch
//
// This gives accurate per-tool token counts that reflect what the LLM ACTUALLY
// sees, not what's registered.

const realToolDefs = new Map<string, { description: string; schema: any }>()

let _tsOriginalFetch: typeof fetch | null = null
let _tsFetchWrapped = false

function wrapFetchForTools(): void {
  if (_tsFetchWrapped) return
  _tsFetchWrapped = true
  _tsOriginalFetch = globalThis.fetch

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : (input as Request).url

    // ONLY intercept LLM API calls. Everything else passes through unchanged.
    const isLLM = url.includes("/chat/completions") || url.includes("/v1/messages") ||
      url.includes("api.deepseek.com") || url.includes("api.openai.com") ||
      url.includes("anthropic.com") || url.includes("openrouter.ai") ||
      url.includes("opencode.ai/zen")

    if (!isLLM || !init || !init.body) {
      return _tsOriginalFetch!.call(globalThis, input, init)
    }

    // Read body — read-only, do NOT modify
    let bodyText = ""
    if (typeof init.body === "string") bodyText = init.body
    else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
      bodyText = new TextDecoder().decode(init.body)
    } else if (init.body instanceof Blob) {
      bodyText = await init.body.text()
    }

    if (bodyText) {
      try {
        const body = JSON.parse(bodyText)
        if (Array.isArray(body.tools)) {
          // Clear previous captures — each LLM call may have different tools
          // (e.g. lazy-load strips to just load_tool)
          realToolDefs.clear()
          for (const t of body.tools) {
            const fn = t?.function
            const name = fn?.name || t?.name || ""
            if (!name) continue
            const desc = fn?.description || t?.description || ""
            const params = fn?.parameters || t?.parameters
            realToolDefs.set(name, { description: desc, schema: params })
          }
        }
      } catch {
        // Body wasn't valid JSON — pass through
      }
    }

    // Pass through UNCHANGED — do not modify init or body
    return _tsOriginalFetch!.call(globalThis, input, init)
  }
}


// ─── Plugin ──────────────────────────────────────────────────────────────────

const TokensSourcePlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { client } = input

  // Wrap fetch FIRST (before lazy-load wraps it). This makes tokens-source
  // the INNER wrapper, so it sees the body AFTER lazy-load strips tools.
  wrapFetchForTools()

  return {
    // Capture system prompt breakdown
    "experimental.chat.system.transform": async (transformInput, output) => {
      const sessionID = (transformInput as any).sessionID as string | undefined
      const rawParts  = output.system.filter(Boolean)
      if (!rawParts.length) return

      const sid = sessionID || "__global__"

      const sources           = parseSystemArray(rawParts)
      const totalSystemChars  = rawParts.join("\n").length
      const totalSystemTokens = est(totalSystemChars)

      snapshots.set(sid, {
        sources,
        totalSystemChars,
        totalSystemTokens,
        timestamp: Date.now(),
      })
    },

    // Capture FINAL messages after ALL transforms — this is exactly what gets sent to the LLM
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output.messages
      if (!msgs || !msgs.length) return

      const breakdowns: MsgBreakdown[] = []
      let totalChars = 0

      for (const msg of msgs) {
        const role = msg.info?.role || "unknown"
        const parts: MsgBreakdown["parts"] = []
        let msgChars = 0

        for (const part of msg.parts) {
          const p = part as any
          const chars = partChars(p)
          const type = partTypeLabel(p)
          parts.push({ type, chars, tokens: est(chars) })
          msgChars += chars
        }

        totalChars += msgChars
        breakdowns.push({
          role,
          parts,
          totalChars: msgChars,
          totalTokens: est(msgChars),
        })
      }

      // Store per-session — use last part of the session key
      // The messages transform doesn't receive sessionID directly,
      // so we store it as the latest snapshot (there's typically one active session)
      const sid = "__latest__"

      msgSnapshots.set(sid, {
        messages: breakdowns,
        totalChars,
        totalTokens: est(totalChars),
        timestamp: Date.now(),
      })
    },

    // Capture tool IDs so we know which tools exist.
    // NOTE: We do NOT use output.parameters here — it's an Effect Schema AST,
    // not a JSON Schema. Stringifying it gives ~6x inflated token counts.
    // The real JSON Schema is captured by the fetch wrapper in realToolDefs.
    // The /tokens command uses realToolDefs when available; this hook only
    // registers the tool ID so we know it exists even before the first LLM call.
    "tool.definition": async (toolInput, toolOutput) => {
      const outAny = toolOutput as any
      const desc = outAny?.description || ""
      const effectParams = outAny?.parameters

      // Convert Effect Schema to real JSON Schema for accurate token estimation
      const jsonSchema = effectToJSONSchema(effectParams)
      const jsonLen = jsonSchema ? JSON.stringify(jsonSchema).length : 0

      const existing = globalTools.find((t) => t.id === toolInput.toolID)
      if (existing) {
        existing.tokens = est(desc.length + jsonLen)
      } else {
        globalTools.push({
          id: toolInput.toolID,
          tokens: est(desc.length + jsonLen),
        })
      }
    },

    // /tokens command
    "command.execute.before": async (cmdInput, cmdOutput) => {
      if (cmdInput.command !== "tokens") return

      const sessionID = cmdInput.sessionID
      const sid       = sessionID || "__global__"
      const snapshot  = snapshots.get(sid)
      const msgSnap   = msgSnapshots.get("__latest__")

      // Fetch exact token data from API
      let lastInput = 0, lastOutput = 0, lastReasoning = 0
      let lastCacheRead = 0, lastCacheWrite = 0
      let totalInput = 0, totalOutput = 0, totalReasoning = 0
      let llmTurns = 0

      try {
        const msgResult = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 200 },
        })
        const messages = msgResult.data ?? []
        for (const msg of messages) {
          if (msg.info.role === "assistant" && msg.info.tokens) {
            const t = msg.info.tokens
            const cacheRead = t.cache?.read ?? 0
            const fullInput = t.input + cacheRead
            totalInput    += fullInput;   lastInput     = fullInput
            totalOutput   += t.output;     lastOutput    = t.output
            totalReasoning += t.reasoning; lastReasoning = t.reasoning
            lastCacheRead  = t.cache?.read  ?? 0
            lastCacheWrite = t.cache?.write ?? 0
            llmTurns++
          }
        }
      } catch { /* show what we have */ }

      // ── Build output ──────────────────────────────────────────────────
      const lines: string[] = []
      const HR = "-".repeat(50)
      const maxLabel = Math.max(
        ...(snapshot?.sources.map(s => s.label.length) || [20]),
        ...(globalTools.map(t => t.id.length) || [8]),
        20
      )
      const colW = Math.min(maxLabel, 45)

      function row(label: string, tokens: number): string {
        const lbl = label.length > colW ? ".." + label.slice(-(colW - 2)) : label
        return "  " + lbl.padEnd(colW + 2) + "~" + tokens.toLocaleString()
      }

      // ── System Prompt ─────────────────────────────────────────────────
      if (snapshot && snapshot.sources.length > 0) {
        lines.push("System Prompt")
        lines.push(HR)
        for (const src of snapshot.sources) {
          lines.push(row(src.label, src.tokens))
        }
        lines.push(HR)
        lines.push(row("total", snapshot.totalSystemTokens))
        lines.push("")
      } else {
        lines.push("System prompt: send a message first")
        lines.push("")
      }

      // ── Tools ─────────────────────────────────────────────────────────
      // PREFER realToolDefs (captured from fetch body — what the LLM ACTUALLY sees).
      // This reflects any tool stripping by other plugins (e.g. opencode-lazy-load
      // strips all tools except load_tool, so realToolDefs will only contain load_tool
      // with the pointer-augmented description).
      //
      // FALL BACK to globalTools (from tool.definition hook) if no LLM call has
      // happened yet — this shows all REGISTERED tools with Effect-converted schemas.
      const toolEntries: ToolBreakdown[] = []
      if (realToolDefs.size > 0) {
        for (const [name, def] of realToolDefs) {
          const descLen = (def.description || "").length
          const schemaLen = def.schema ? JSON.stringify(def.schema).length : 0
          toolEntries.push({ id: name, tokens: est(descLen + schemaLen) })
        }
      } else {
        for (const t of globalTools) {
          toolEntries.push({ id: t.id, tokens: t.tokens })
        }
      }

      if (toolEntries.length > 0) {
        const totalToolTokens = toolEntries.reduce((s, t) => s + t.tokens, 0)
        const sourceLabel = realToolDefs.size > 0 ? " (from API body)" : " (registered)"
        lines.push("Tools" + sourceLabel)
        lines.push(HR)
        const sorted = [...toolEntries].sort((a, b) => b.tokens - a.tokens)
        for (const tool of sorted) {
          lines.push(row(tool.id, tool.tokens))
        }
        lines.push(HR)
        lines.push(row("total (" + sorted.length + ")", totalToolTokens))
        lines.push("")
      }

      // ── Messages (from experimental.chat.messages.transform) ──────────
      if (msgSnap && msgSnap.messages.length > 0) {
        lines.push("Messages (" + msgSnap.messages.length + ")")
        lines.push(HR)

        // Group by role for summary
        const byRole = new Map<string, { chars: number; tokens: number; count: number }>()
        const byPartType = new Map<string, { chars: number; tokens: number; count: number }>()

        for (const msg of msgSnap.messages) {
          const existing = byRole.get(msg.role) || { chars: 0, tokens: 0, count: 0 }
          existing.chars += msg.totalChars
          existing.tokens += msg.totalTokens
          existing.count++
          byRole.set(msg.role, existing)

          for (const part of msg.parts) {
            const pe = byPartType.get(part.type) || { chars: 0, tokens: 0, count: 0 }
            pe.chars += part.chars
            pe.tokens += part.tokens
            pe.count++
            byPartType.set(part.type, pe)
          }
        }

        // Show per-role breakdown
        for (const [role, data] of byRole) {
          lines.push(row(role + " (" + data.count + ")", data.tokens))
        }
        lines.push("")

        // Show per-part-type breakdown
        lines.push("  Message part types:")
        const sortedParts = [...byPartType.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
        for (const [type, data] of sortedParts) {
          lines.push(row("  " + type + " (" + data.count + ")", data.tokens))
        }

        lines.push(HR)
        lines.push(row("total", msgSnap.totalTokens))
        lines.push("")
      }

      // ── Estimated total ───────────────────────────────────────────────
      const sysTokens = snapshot?.totalSystemTokens ?? 0
      const toolTokens = toolEntries.reduce((s, t) => s + t.tokens, 0)
      const msgTokens = msgSnap?.totalTokens ?? 0
      const estimatedTotal = sysTokens + toolTokens + msgTokens

      lines.push("Estimated Total")
      lines.push(HR)
      lines.push(row("system", sysTokens))
      lines.push(row("tools", toolTokens))
      lines.push(row("messages", msgTokens))
      lines.push(HR)
      lines.push(row("ESTIMATED", estimatedTotal))

      // ── API actual ────────────────────────────────────────────────────
      if (lastInput > 0) {
        lines.push("")
        lines.push("API Actual (last call)")
        lines.push(HR)
        lines.push("  in:" + lastInput + " (fresh:" + (lastInput - lastCacheRead) + " cache_r:" + lastCacheRead + ")" +
          " out:" + lastOutput + " reason:" + lastReasoning +
          (lastCacheWrite > 0 ? " cache_w:" + lastCacheWrite : ""))

        const diff = lastInput - estimatedTotal
        if (diff !== 0) {
          lines.push("  estimated:" + estimatedTotal + " actual:" + lastInput + " diff:" + diff)
        }

        lines.push("")
        lines.push("Session  in:" + totalInput + " out:" + totalOutput + " reason:" + totalReasoning + " turns:" + llmTurns)
      }

      // ── Deliver — NO throw, NO LLM call ──────────────────────────────
      const text = lines.join("\n")

      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text }],
          },
        })
      } catch { /* ignore */ }

      Promise.resolve().then(async () => {
        try {
          await client.session.abort({ path: { id: sessionID } })
        } catch { /* acceptable */ }
      })

      cmdOutput.parts.length = 0
    },
  }
}

export default {
  id: "tokens-source",
  server: TokensSourcePlugin,
}
