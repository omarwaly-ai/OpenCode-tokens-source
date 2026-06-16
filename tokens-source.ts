// .opencode/plugin/tokens-source.ts
// Token usage breakdown by source for opencode CLI
// Hooks: experimental.chat.system.transform + experimental.chat.messages.transform
//        + tool.definition + command.execute.before

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"

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

// ─── Plugin ──────────────────────────────────────────────────────────────────

const TokensSourcePlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { client } = input

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

    // Capture tool definitions
    "tool.definition": async (toolInput, toolOutput) => {
      const descLen = (toolOutput.description || "").length
      const outAny = toolOutput as any
      const schemaObj = outAny.jsonSchema
      const schemaLen = schemaObj ? JSON.stringify(schemaObj).length : 0
      const totalChars = descLen + schemaLen
      const tokens = est(totalChars)

      const existing = globalTools.find((t) => t.id === toolInput.toolID)
      if (existing) {
        existing.tokens = tokens
      } else {
        globalTools.push({ id: toolInput.toolID, tokens })
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
            totalInput    += t.input;      lastInput     = t.input
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
      if (globalTools.length > 0) {
        const totalToolTokens = globalTools.reduce((s, t) => s + t.tokens, 0)
        lines.push("Tools")
        lines.push(HR)
        const sorted = [...globalTools].sort((a, b) => b.tokens - a.tokens)
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
      const toolTokens = globalTools.reduce((s, t) => s + t.tokens, 0)
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
        lines.push("  in:" + lastInput + " out:" + lastOutput + " reason:" + lastReasoning +
          (lastCacheRead > 0 ? " cache_r:" + lastCacheRead : "") +
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

export default TokensSourcePlugin
