import type { Register } from 'claude-code'

const PLUGIN = 'critical-decisions'
const DEFAULT_TOOL = `mcp__${PLUGIN}__record_decision`

// What the person marked as critical in this project, in their words and as
// the areas, keywords and paths extracted from them.
export type Area = { name: string; keywords: string[]; paths: string[] }
export type Config = { description: string; areas: Area[] }
type Decision = { time: string; area: string; decision: string; reason: string; alternative: string }

// Edits are matched by path and keyword. Shell commands and MCP tools (publishing,
// sending, writing to a database) by keyword in what they were given.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BAND_ROWS = 3
const CLEAR = new Set(['clear', 'reset', 'limpar', 'apagar', 'borrar'])

const storeKey = (cwd: string) => `config:${cwd}`
const noticeKey = (cwd: string) => `notice-seen:${cwd}`

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

export function parseAreas(text: string): Area[] | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const raw = JSON.parse(m[0]) as { areas?: unknown }
    if (!Array.isArray(raw.areas)) return undefined
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => (x as string).trim()) : [])
    const areas = raw.areas
      .map((a: any) => ({ name: String(a?.name ?? '').trim(), keywords: strs(a?.keywords), paths: strs(a?.paths) }))
      .filter(a => a.name && (a.keywords.length || a.paths.length))
    return areas.length ? areas : undefined
  } catch {
    return undefined
  }
}

function describeConfig(c: Config | undefined): string {
  if (!c)
    return [
      'Default protection: the agent records decisions it makes without being asked that add or drop content, pick rules or values you did not set, depart from your instructions, or are hard to undo.',
      'Nothing specific to this project yet. Say what is critical for you: /critical-areas <your words>, e.g.',
      '  /critical-areas pricing and tax rules, anything in src/billing, database migrations',
      '  /critical-areas no topic or source I did not ask for, nothing published without me',
    ].join('\n')
  const rows = c.areas.map(a => {
    const bits = [a.keywords.length ? `keywords: ${a.keywords.join(', ')}` : '', a.paths.length ? `paths: ${a.paths.join(', ')}` : '']
    return `• ${a.name} — ${bits.filter(Boolean).join(' · ')}`
  })
  return [`Critical in this project: "${c.description}"`, ...rows, '', '/critical-areas <text> replaces it · /critical-areas clear removes it'].join('\n')
}

// Always in the system prompt: what counts as critical by default, in any kind of
// project. The working agent judges against it; the mod reads no files and calls no model.
const DEFAULT_CRITERIA = [
  'A decision is critical when you make it on your own, mid-task, without the user asking for it literally, and it:',
  '- adds, removes or swaps something the user did not ask for: a topic, source, claim, comparison, feature, dependency or step;',
  '- picks a value, rule, formula, default, format, structure or schema the user did not specify, where another reasonable choice existed;',
  "- departs from or works around the user's instructions, or the project's own instructions you were given (such as CLAUDE.md);",
  '- is hard to undo or reaches outside this session: deleting, overwriting, publishing, sending, deploying, migrating data, spending money;',
  "- fills a gap in the request with an assumption that changes the result.",
  "Judge what matters with what you know of this project, its instructions included. Mechanical steps that follow directly from the request are not critical.",
].join('\n')

export function systemSection(c: Config | undefined): string {
  const marked = c
    ? [
        `The user also marked these as critical in this project: "${c.description}".`,
        `Areas: ${c.areas.map(a => a.name).join(', ')}. Any decision of yours that touches them is critical, even a small one.`,
      ]
    : ['The user has not said what is critical in this project, so these defaults are all there is.']
  return [
    '# Critical decisions',
    DEFAULT_CRITERIA,
    ...marked,
    'Whenever you make a critical decision, call the record_decision tool with the decision, the reason and the alternative you ruled out, and mention it in your reply. A choice the user asked for word for word needs no record.',
  ].join('\n')
}

function reminder(areas: string[], tool: string): string {
  return `[${PLUGIN}] You touched what the user marked as critical (${areas.join(', ')}). If this was your own decision, not something the user literally asked for, call ${tool} with the decision, the reason and the alternative you ruled out, and say so in your reply. If it was asked for literally, carry on without recording.`
}

function report(list: Decision[]): string {
  if (!list.length) return 'No critical decisions recorded in this session.'
  return list
    .map((d, i) => `${i + 1}. [${d.time}] (${d.area}) ${d.decision}\n   because: ${d.reason}\n   ruled out: ${d.alternative || '—'}`)
    .join('\n')
}

export const register: Register = on => {
  let config: Config | undefined
  let cwd = ''
  let toolName = DEFAULT_TOOL
  const decisions: Decision[] = []
  let pending: Decision[] = [] // on the band until the person dismisses them
  let notice = false // the first-use line: default protection, how to say what is critical
  // true when the notice was up: the caller saves that it was seen
  const dismissNotice = () => {
    const was = notice
    notice = false
    return was
  }
  const warned = new Set<string>() // per turn

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    config = ((await $.store.get(storeKey(cwd))) as Config | undefined) ?? undefined
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
        },
        required: ['area', 'decision', 'reason'],
      },
    })) as { tool?: string } | undefined
    if (reg?.tool) toolName = reg.tool // the name the agent sees; DEFAULT_TOOL unless the plugin is renamed
    await $.command.register({ name: 'critical-areas', description: 'Describe what is critical in this project (no text: show it; "clear": remove it)' })
    await $.command.register({ name: 'critical-list', description: 'List the critical decisions recorded in this session' })
    await $.command.register({ name: 'critical-ok', description: 'Dismiss the critical decisions shown above the prompt' })
    return r
  })

  on('command.run', { command: 'critical-areas' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) return { text: describeConfig(config) }
    if (CLEAR.has(args.toLowerCase())) {
      config = undefined
      await $.store.delete(storeKey(cwd))
      return { text: 'Removed. Nothing is marked as critical in this project now.' }
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
    return { text: `Saved for ${cwd}.\n\n${describeConfig(config)}` }
  })

  on('prompt.compose', async (_$, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: `${PLUGIN}:rules`, text: systemSection(config), scope: 'session' as const }] }
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
            <Text dimColor>To say what is critical for you: /critical-areas &lt;your words&gt;  </Text>
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
    const shown = pending.slice(-BAND_ROWS)
    const hidden = pending.length - shown.length
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box>
          <Text color="yellow" bold>⚠️ {pending.length === 1 ? 'Critical decision' : `${pending.length} critical decisions`}  </Text>
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
          <Text color="yellow">  [{d.time}] ({d.area}) {d.decision} <Text dimColor>— because {d.reason}</Text></Text>
        ))}
        {hidden ? <Text dimColor>  +{hidden} earlier: /critical-list</Text> : null}
      </Box>
    )
  })

  // The agent declares a decision: warn the person and keep it on the band.
  on('tool.call', { tool: DEFAULT_TOOL }, ($, e) => {
    const i = e as unknown as { area?: string; decision?: string; reason?: string; alternative_ruled_out?: string }
    if (!String(i.decision ?? '').trim() || !String(i.reason ?? '').trim())
      return {
        result: 'Nothing recorded: "decision" and "reason" must each be one non-empty sentence. Call record_decision again with both.',
        isError: true,
      } as any
    const d: Decision = {
      time: new Date().toTimeString().slice(0, 5),
      area: String(i.area || 'general'),
      decision: String(i.decision ?? ''),
      reason: String(i.reason ?? ''),
      alternative: String(i.alternative_ruled_out ?? ''),
    }
    decisions.push(d)
    pending.push(d)
    $.ui.toast(`⚠️ CRITICAL DECISION [${d.area}] ${d.decision} — because ${d.reason}`, { timeoutMs: 20000 })
    $.ui.status(`⚠️ critical decision: ${d.decision.slice(0, 60)}`)
    $.ui.invalidate('ui.render')
    return { result: `Decision recorded (${decisions.length} this session) and the user was warned. Mention it in your reply.` }
  })

  // An edit touched a critical area: warn the person and remind the agent to declare.
  on('tool.call', async ($, e, next) => {
    const areas = touchedAreas(config, e.tool, e as unknown as Record<string, unknown>).filter(a => !warned.has(a))
    const r = await next(e)
    if (!areas.length || r.deny !== undefined || r.isError === true) return r
    areas.forEach(a => warned.add(a))
    $.ui.toast(`⚠️ Critical area touched: ${areas.join(', ')}`, { timeoutMs: 8000 })
    return { ...r, context: [...(r.context ?? []), reminder(areas, toolName)] } as typeof r
  })

  on('turn.complete', async (_$, e, next) => {
    warned.clear()
    return next(e)
  })
}
