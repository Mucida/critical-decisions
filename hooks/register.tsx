import type { Register } from 'claude-code'

const PLUGIN = 'critical-decisions'
const DEFAULT_TOOL = `mcp__${PLUGIN}__record_decision`
const SAVE_TOOL = `mcp__${PLUGIN}__save_critical_areas`

// What the person marked as critical in this project, in their words and as
// the areas, keywords and paths extracted from them.
export type Area = { name: string; keywords: string[]; paths: string[] }
export type Config = { description: string; areas: Area[] }
// undo: the person may want to take it back (red). know: worth knowing (yellow).
export type Level = 'undo' | 'know'
type Decision = { id: number; time: string; level: Level; area: string; decision: string; reason: string; alternative: string }
// Records the person marked as not critical: shown to the agent so it stops recording their like.
type Learned = { area: string; decision: string }
const LEARNED_MAX = 10

// Edits are matched by path and keyword. Shell commands and MCP tools (publishing,
// sending, writing to a database) by keyword in what they were given.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BAND_ROWS = 3
const CLEAR = new Set(['clear', 'reset', 'limpar', 'apagar', 'borrar'])

const storeKey = (cwd: string) => `config:${cwd}`
const noticeKey = (cwd: string) => `notice-seen:${cwd}`
const learnedKey = (cwd: string) => `learned:${cwd}`

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
}

// `src/billing/**`, `*.sql`, `migrations/` → a regex tested against the path.
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  const body = g
    .split('**')
    .map(part => part.split('*').map(escapeRe).join('[^/]*'))
    .join('.*')
  return new RegExp(`(^|/)${body}$`, 'i')
}

export function keywordRegExp(word: string): RegExp {
  const w = escapeRe(word.trim())
  const start = /^\w/.test(word.trim()) ? '\\b' : ''
  return new RegExp(`${start}${w}`, 'i')
}

function editedText(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const k of ['new_string', 'content', 'new_source']) if (typeof input[k] === 'string') parts.push(input[k] as string)
  if (Array.isArray(input.edits))
    for (const ed of input.edits as Record<string, unknown>[]) if (typeof ed?.new_string === 'string') parts.push(ed.new_string)
  return parts.join('\n')
}

function watchedText(tool: string, input: Record<string, unknown>): string | undefined {
  if (EDIT_TOOLS.has(tool)) return editedText(input)
  if (tool === 'Bash') return String(input.command ?? '')
  if (tool.startsWith('mcp__') && !tool.startsWith(`mcp__${PLUGIN}__`)) {
    const { tool: _t, ...rest } = input
    return JSON.stringify(rest)
  }
  return undefined
}

export function touchedAreas(config: Config | undefined, tool: string, input: Record<string, unknown>): string[] {
  if (!config) return []
  const text = watchedText(tool, input)
  if (text === undefined) return []
  const path = EDIT_TOOLS.has(tool) ? String(input.file_path ?? input.notebook_path ?? '') : ''
  const hits: string[] = []
  for (const a of config.areas) {
    const byPath = path !== '' && a.paths.some(p => p && globToRegExp(p).test(path))
    const byWord = text !== '' && a.keywords.some(k => k && keywordRegExp(k).test(text))
    if (byPath || byWord) hits.push(a.name)
  }
  return hits
}

// Turns the person's free text into areas. The model only proposes; the
// person sees the result and can run /critical-areas again.
const EXTRACT_SYSTEM = `You turn a person's description of what is critical in their project into detection rules for an AI agent working on it. The project may be code, writing (articles, books, docs), data or anything else.
Answer with JSON only, no prose, no code fence:
{"areas":[{"name":"short_snake_case","keywords":["identifier or term"],"paths":["glob"]}]}
- 1 to 8 areas.
- keywords: identifiers, names, commands or domain terms likely to appear in the text, code or commands that touch the area (e.g. "unit_price", "git push", "publish"). Prefer specific terms over common words. Up to 12 per area.
- paths: globs relative to the project root (e.g. "src/billing/**", "**/*.sql", "drafts/"). Only when the description names or implies files or folders; otherwise [].
- The description may be in any language. Area names in English snake_case; keywords as they would appear in the work: identifiers exactly as written, domain terms in the description's language and, when the work is likely in English, their English form too.
- Never invent identifiers the description gives no hint of.`

// Areas from the model's JSON or from save_critical_areas' input; undefined when none is usable.
export function areasFrom(list: unknown): Area[] | undefined {
  if (!Array.isArray(list)) return undefined
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => (x as string).trim()) : [])
  const areas = list
    .map((a: any) => ({ name: String(a?.name ?? '').trim(), keywords: strs(a?.keywords), paths: strs(a?.paths) }))
    .filter(a => a.name && (a.keywords.length || a.paths.length))
  return areas.length ? areas : undefined
}

export function parseAreas(text: string): Area[] | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    return areasFrom((JSON.parse(m[0]) as { areas?: unknown }).areas)
  } catch {
    return undefined
  }
}


function describeConfig(c: Config | undefined, learned: Learned[]): string {
  const lines = c
    ? [
        `Critical in this project: "${c.description}"`,
        ...c.areas.map(a => {
          const bits = [a.keywords.length ? `keywords: ${a.keywords.join(', ')}` : '', a.paths.length ? `paths: ${a.paths.join(', ')}` : '']
          return `• ${a.name} — ${bits.filter(Boolean).join(' · ')}`
        }),
        '',
        '/critical-areas <text> or /critical-areas auto replaces it · /critical-areas clear removes it',
      ]
    : [
        'Default protection: the agent records decisions it makes without being asked that you would likely want to undo or rethink.',
        'Nothing specific to this project yet. To make it yours:',
        '  /critical-areas auto   the agent proposes areas from what it knows of this project',
        '  /critical-areas <your words>, e.g. /critical-areas pricing and tax rules, anything in src/billing',
        '  /critical-areas no topic or source I did not ask for, nothing published without me',
      ]
  if (learned.length) lines.push('', `Marked as not critical (${learned.length}/${LEARNED_MAX}):`, ...learned.map(l => `• (${l.area}) ${l.decision}`))
  return lines.join('\n')
}

// Always in the system prompt: what counts as critical by default, in any kind of
// project. The working agent judges against it; the mod reads no files and calls no model.
const DEFAULT_CRITERIA = [
  'Record a decision only when the user would likely want to undo or rethink it if they saw it. When in doubt, do not record. Usually a task has none or one.',
  'It qualifies when you made it on your own, without the user asking for it literally, and it:',
  '- adds, removes or swaps something the user did not ask for: a topic, source, claim, comparison, feature, dependency or step;',
  '- picks a value, rule, formula, default, structure or schema the user did not specify, where another reasonable choice existed;',
  "- departs from or works around the user's instructions, or the project's own instructions you were given (such as CLAUDE.md);",
  '- is hard to undo or reaches outside this session: deleting, overwriting, publishing, sending, deploying, migrating data, spending money;',
  '- fills a gap in the request with an assumption that changes the result.',
  'A choice the user left to you ("you decide", "pick one") still qualifies when it changes the result: they delegated it, so tell them what you picked.',
  "Not critical: naming, wording and formatting, refactors that keep behaviour, steps that follow directly from the request, and choices that follow the project's conventions.",
  'Group related choices into one record. Judge what matters with what you know of this project, its instructions included.',
  'level "undo" when the user may well want it taken back (it changes scope, a rule or the result, or is hard to undo); "know" when it is a reasonable choice they should just be aware of.',
].join('\n')

export function systemSection(c: Config | undefined, learned: Learned[] = []): string {
  const marked = c
    ? [
        `The user also marked these as critical in this project: "${c.description}".`,
        `Areas: ${c.areas.map(a => a.name).join(', ')}. A decision of yours that touches them qualifies even when small.`,
      ]
    : ['The user has not said what is critical in this project, so these defaults are all there is.']
  const taught = learned.length
    ? ['The user marked these earlier records as not critical; do not record their like:', ...learned.map(l => `- (${l.area}) ${l.decision}`)]
    : []
  return [
    '# Critical decisions',
    DEFAULT_CRITERIA,
    ...marked,
    ...taught,
    'When a decision qualifies, call the record_decision tool with it, the reason, the alternative you ruled out and its level, before your final reply, then mention it in the reply. Listing it only in your reply is not enough: the user sees what you record.',
  ].join('\n')
}

// After the first write of a turn with nothing recorded: where a decision is made, the
// agent tends to tell it in prose instead of recording it. One short line per turn at most.
function writeNudge(tool: string): string {
  return `[${PLUGIN}] If what you just wrote carries a choice the user did not make (a value, rule, scope or assumption that changes the result, including one they left to you), call ${tool} now, before your reply; a decision told only in prose does not reach the user's band. Otherwise ignore this.`
}

function reminder(areas: string[], tool: string): string {
  return `[${PLUGIN}] You touched what the user marked as critical (${areas.join(', ')}). If this was your own decision, not something the user literally asked for, call ${tool} with the decision, the reason and the alternative you ruled out, and say so in your reply. If it was asked for literally, carry on without recording.`
}

const LEVEL_LABEL: Record<Level, string> = { undo: 'to rethink', know: 'to know' }

function report(list: Decision[]): string {
  if (!list.length) return 'No critical decisions recorded in this session.'
  return list
    .map((d, i) => `${i + 1}. [${d.time}] ${LEVEL_LABEL[d.level]} (${d.area}) ${d.decision}\n   because: ${d.reason}\n   ruled out: ${d.alternative || '—'}`)
    .join('\n')
}

// Red first, newest first within each level.
export function bandOrder<T extends { level: Level }>(list: T[]): T[] {
  const newest = [...list].reverse()
  return [...newest.filter(d => d.level === 'undo'), ...newest.filter(d => d.level === 'know')]
}

function rethinkPrompt(d: Decision): string {
  return `Rethink this decision you made: "${d.decision}" (because ${d.reason}). Undo it if you can, propose other ways, and ask me before picking one.`
}

const AUTO_PROMPT = `Based on what you already know of this project and its instructions, propose up to 6 areas where a decision you make on your own would be critical for me (rules, money, data, publishing, scope or anything this project treats as important). For each: a short snake_case name, keywords as they appear in the work, and path globs when it lives in specific files. Save them with the save_critical_areas tool (load it with ToolSearch if it is not listed), with a one-line description in my language. Then show me the areas and tell me /critical-areas clear undoes it. Do not read new files just for this.`

export const register: Register = on => {
  let config: Config | undefined
  let cwd = ''
  let toolName = DEFAULT_TOOL
  let nextId = 1
  const decisions: Decision[] = []
  let pending: Decision[] = [] // on the band until the person dismisses them
  let learned: Learned[] = []
  let notice = false // the first-use line: default protection, how to make it yours
  // true when the notice was up: the caller saves that it was seen
  const dismissNotice = () => {
    const was = notice
    notice = false
    return was
  }
  const warned = new Set<string>() // per turn
  let nudged = false // per turn: the write nudge went out, or a decision was recorded

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    config = ((await $.store.get(storeKey(cwd))) as Config | undefined) ?? undefined
    learned = ((await $.store.get(learnedKey(cwd))) as Learned[] | undefined) ?? []
    notice = !config && !(await $.store.get(noticeKey(cwd)))
    const reg = (await $.tool.register({
      name: 'record_decision',
      description:
        'Record a critical decision you made on your own, mid-task, that the user did not literally ask for (see "Critical decisions" in the system prompt). The user sees it right away above the prompt. Call it once per decision, then mention the decision in your reply.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          area: {
            type: 'string',
            description: 'One of the areas the user marked as critical, or "general" when only the default criteria apply. Example: "pricing".',
          },
          decision: {
            type: 'string',
            description: 'What you decided, in one sentence. Example: "Added a comparison with solar panels to the paragraph on wind power".',
          },
          reason: { type: 'string', description: 'Why, in one sentence. Example: "the paragraph needed a reference point".' },
          alternative_ruled_out: {
            type: 'string',
            description: 'What you considered and did not do. Example: "keep the paragraph on wind power alone".',
          },
          level: {
            type: 'string',
            enum: ['undo', 'know'],
            description:
              '"undo" when the user may well want it taken back (it changes scope, a rule or the result, or is hard to undo); "know" when it is a reasonable choice they should be aware of. Default "know".',
          },
        },
        required: ['area', 'decision', 'reason'],
      },
    })) as { tool?: string } | undefined
    if (reg?.tool) toolName = reg.tool // the name the agent sees; DEFAULT_TOOL unless the plugin is renamed
    await $.tool.register({
      name: 'save_critical_areas',
      description:
        'Save the areas that are critical in this project, replacing the current ones. Use it only when the user asked for it (/critical-areas auto).',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'One line, in the user\'s language. Example: "preços e impostos, migrations, publicação".' },
          areas: {
            type: 'array',
            description: '1 to 6 areas.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'snake_case. Example: "pricing".' },
                keywords: { type: 'array', items: { type: 'string' }, description: 'Terms as they appear in the work. Example: ["unit_price", "tax_rate"].' },
                paths: { type: 'array', items: { type: 'string' }, description: 'Globs from the project root, or []. Example: ["src/billing/**"].' },
              },
              required: ['name', 'keywords', 'paths'],
            },
          },
        },
        required: ['description', 'areas'],
      },
    })
    await $.command.register({
      name: 'critical-areas',
      description: 'Say what is critical in this project ("auto": the agent proposes it; no text: show it; "clear": remove it)',
    })
    await $.command.register({ name: 'critical-list', description: 'List the critical decisions recorded in this session' })
    await $.command.register({ name: 'critical-ok', description: 'Dismiss the critical decisions shown above the prompt' })
    return r
  })

  on('command.run', { command: 'critical-areas' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) return { text: describeConfig(config, learned) }
    if (CLEAR.has(args.toLowerCase())) {
      config = undefined
      learned = []
      await $.store.delete(storeKey(cwd))
      await $.store.delete(learnedKey(cwd))
      return { text: 'Removed, along with what was marked as not critical. Only the default protection is on in this project now.' }
    }
    if (args.toLowerCase() === 'auto') {
      // A command's hook holds the turn: submit once it has returned.
      $.clock.after(1, () => void $.prompt.submit({ text: AUTO_PROMPT, asUser: true }))
      return { text: 'Asking the agent to propose the critical areas of this project.' }
    }
    const r = await $.model.complete({ model: 'haiku', system: EXTRACT_SYSTEM, prompt: args, maxTokens: 1500, timeoutMs: 30000 })
    const areas = r.isAnswered ? parseAreas(r.text) : undefined
    if (!areas) {
      const why = r.isAnswered ? 'the answer could not be read as areas' : `the model call failed (${r.reason})`
      return { text: `Nothing saved: ${why}. Try again, naming files, folders or identifiers, e.g. /critical-areas price and tax in src/billing/**, the orders.status column` }
    }
    config = { description: args, areas }
    await $.store.set(storeKey(cwd), config)
    if (dismissNotice()) await $.store.set(noticeKey(cwd), true)
    $.ui.invalidate('ui.render')
    return { text: `Saved for ${cwd}.\n\n${describeConfig(config, learned)}` }
  })

  on('prompt.compose', async (_$, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: `${PLUGIN}:rules`, text: systemSection(config, learned), scope: 'session' as const }] }
  })

  on('command.run', { command: 'critical-list' }, () => ({ text: report(decisions) }))

  on('command.run', { command: 'critical-ok' }, async $ => {
    const n = pending.length
    pending = []
    if (dismissNotice()) await $.store.set(noticeKey(cwd), true)
    $.ui.invalidate('ui.render')
    return { text: n ? `${n} decision(s) dismissed. /critical-list still lists them all.` : 'Nothing to dismiss.' }
  })

  // The band stays until dismissed: a toast goes away by itself, this does not.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (pending.length === 0 && !notice)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (pending.length === 0)
      return (
        <Box flexDirection="column">
          {await next(e)}
          <Box>
            <Text color="yellow">🛡 critical-decisions: default protection is on. </Text>
            <Text dimColor>To make it yours: /critical-areas auto, or /critical-areas &lt;your words&gt;  </Text>
            <Button
              key="ok"
              label="ok"
              role="dismiss"
              onPress={async () => {
                if (dismissNotice()) await $.store.set(noticeKey(cwd), true)
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
        </Box>
      )
    const ordered = bandOrder(pending)
    const shown = ordered.slice(0, BAND_ROWS)
    const hidden = ordered.length - shown.length
    const toUndo = pending.filter(d => d.level === 'undo').length
    const toKnow = pending.length - toUndo
    const counts = [toUndo ? `${toUndo} ${LEVEL_LABEL.undo}` : '', toKnow ? `${toKnow} ${LEVEL_LABEL.know}` : ''].filter(Boolean).join(' · ')
    const drop = (id: number) => {
      pending = pending.filter(d => d.id !== id)
      $.ui.invalidate('ui.render')
    }
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box>
          <Text color={toUndo ? 'red' : 'yellow'} bold>⚠️ Critical decisions: {counts}  </Text>
          <Button
            key="ok"
            label="ok"
            role="dismiss"
            onPress={() => {
              pending = []
              $.ui.invalidate('ui.render')
            }}
          />
          <Text dimColor>  (or /critical-ok)</Text>
        </Box>
        {shown.map(d => (
          <Box key={`row-${d.id}`}>
            <Text color={d.level === 'undo' ? 'red' : 'yellow'}>  [{d.time}] ({d.area}) {d.decision} <Text dimColor>— because {d.reason}  </Text></Text>
            <Button
              key={`rethink-${d.id}`}
              label="rethink"
              onPress={() => {
                drop(d.id)
                void $.prompt.submit({ text: rethinkPrompt(d), asUser: true })
              }}
            />
            <Text> </Text>
            <Button
              key={`not-critical-${d.id}`}
              label="not critical"
              onPress={async () => {
                drop(d.id)
                learned = [...learned, { area: d.area, decision: d.decision.slice(0, 160) }].slice(-LEARNED_MAX)
                await $.store.set(learnedKey(cwd), learned)
              }}
            />
          </Box>
        ))}
        {hidden ? <Text dimColor>  +{hidden} more: /critical-list</Text> : null}
      </Box>
    )
  })

  // The agent declares a decision: warn the person and keep it on the band.
  on('tool.call', { tool: DEFAULT_TOOL }, ($, e) => {
    const i = e as unknown as { area?: string; decision?: string; reason?: string; alternative_ruled_out?: string; level?: string }
    if (!String(i.decision ?? '').trim() || !String(i.reason ?? '').trim())
      return {
        result: 'Nothing recorded: "decision" and "reason" must each be one non-empty sentence. Call record_decision again with both.',
        isError: true,
      } as any
    const d: Decision = {
      id: nextId++,
      time: new Date().toTimeString().slice(0, 5),
      level: i.level === 'undo' ? 'undo' : 'know',
      area: String(i.area || 'general'),
      decision: String(i.decision ?? ''),
      reason: String(i.reason ?? ''),
      alternative: String(i.alternative_ruled_out ?? ''),
    }
    decisions.push(d)
    nudged = true
    pending.push(d)
    $.ui.toast(`${d.level === 'undo' ? '🔴' : '🟡'} Critical decision [${d.area}] ${d.decision} — because ${d.reason}`, { timeoutMs: 20000 })
    $.ui.status(`⚠️ critical decision: ${d.decision.slice(0, 60)}`)
    $.ui.invalidate('ui.render')
    return { result: `Decision recorded (${decisions.length} this session) and the user was warned. Mention it in your reply.` }
  })

  // The agent saves the areas it proposed after /critical-areas auto.
  on('tool.call', { tool: SAVE_TOOL }, async ($, e) => {
    const i = e as unknown as { description?: string; areas?: unknown }
    const areas = areasFrom(i.areas)
    const description = String(i.description ?? '').trim()
    if (!areas || !description)
      return {
        result:
          'Nothing saved: give a one-line "description" and 1 to 6 "areas", each with a name and at least one keyword or path. Call save_critical_areas again.',
        isError: true,
      } as any
    config = { description, areas: areas.slice(0, 6) }
    await $.store.set(storeKey(cwd), config)
    if (dismissNotice()) await $.store.set(noticeKey(cwd), true)
    $.ui.toast(`🛡 Critical areas saved: ${config.areas.map(a => a.name).join(', ')}`, { timeoutMs: 8000 })
    $.ui.invalidate('ui.render')
    return { result: `Saved. Show the user these areas and say /critical-areas clear undoes it.\n\n${describeConfig(config, learned)}` }
  })

  // An edit touched a critical area: warn the person and remind the agent to declare.
  on('tool.call', async ($, e, next) => {
    const areas = touchedAreas(config, e.tool, e as unknown as Record<string, unknown>).filter(a => !warned.has(a))
    const r = await next(e)
    if (r.deny !== undefined || r.isError === true) return r
    const notes: string[] = []
    if (areas.length) {
      areas.forEach(a => warned.add(a))
      $.ui.toast(`⚠️ Critical area touched: ${areas.join(', ')}`, { timeoutMs: 8000 })
      notes.push(reminder(areas, toolName))
    }
    const writes = EDIT_TOOLS.has(e.tool) || (e.tool.startsWith('mcp__') && !e.tool.startsWith(`mcp__${PLUGIN}__`))
    if (writes && !nudged) {
      nudged = true
      notes.push(writeNudge(toolName))
    }
    if (!notes.length) return r
    return { ...r, context: [...(r.context ?? []), ...notes] } as typeof r
  })

  on('turn.complete', async (_$, e, next) => {
    warned.clear()
    nudged = false
    return next(e)
  })
}
