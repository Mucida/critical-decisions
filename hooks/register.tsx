import type { Register } from 'claude-code'

const PLUGIN = 'critical-decisions'
const DEFAULT_TOOL = `mcp__${PLUGIN}__record_decision`

// What the person marked as critical in this project, in their words and as
// the areas, keywords and paths extracted from them.
export type Area = { name: string; keywords: string[]; paths: string[] }
export type Config = { description: string; areas: Area[] }
type Decision = { time: string; area: string; decision: string; reason: string; alternative: string }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Prose files mention terms without changing behaviour: keywords skip them, paths still count.
const PROSE = /\.(md|mdx|txt|rst)$/i
const BAND_ROWS = 3
const CLEAR = new Set(['clear', 'reset', 'limpar', 'apagar', 'borrar'])

const storeKey = (cwd: string) => `config:${cwd}`

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

export function touchedAreas(config: Config | undefined, tool: string, input: Record<string, unknown>): string[] {
  if (!config || !EDIT_TOOLS.has(tool)) return []
  const path = String(input.file_path ?? input.notebook_path ?? '')
  const text = PROSE.test(path) ? '' : editedText(input)
  const hits: string[] = []
  for (const a of config.areas) {
    const byPath = a.paths.some(p => p && globToRegExp(p).test(path))
    const byWord = text !== '' && a.keywords.some(k => k && keywordRegExp(k).test(text))
    if (byPath || byWord) hits.push(a.name)
  }
  return hits
}

// Turns the person's free text into areas. The model only proposes; the
// person sees the result and can run /critical-areas again.
const EXTRACT_SYSTEM = `You turn a developer's description of what is critical in their project into detection rules for a code-editing agent.
Answer with JSON only, no prose, no code fence:
{"areas":[{"name":"short_snake_case","keywords":["identifier or term"],"paths":["glob"]}]}
- 1 to 8 areas.
- keywords: identifiers, column names, function names or domain terms likely to appear in code that touches the area. Prefer specific identifiers over common words. Up to 12 per area.
- paths: globs relative to the project root (e.g. "src/billing/**", "**/*.sql", "migrations/"). Only when the description names or implies files or folders; otherwise [].
- The description may be in any language. Area names in English snake_case; keywords as they would appear in the code: identifiers exactly as written, domain terms in the description's language and, when the code is likely in English, their English form too.
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
  if (!c) return 'Nothing marked as critical in this project yet.\nRun /critical-areas <what is critical here>, e.g. /critical-areas pricing and tax rules, anything in src/billing, database migrations'
  const rows = c.areas.map(a => {
    const bits = [a.keywords.length ? `keywords: ${a.keywords.join(', ')}` : '', a.paths.length ? `paths: ${a.paths.join(', ')}` : '']
    return `• ${a.name} — ${bits.filter(Boolean).join(' · ')}`
  })
  return [`Critical in this project: "${c.description}"`, ...rows, '', '/critical-areas <text> replaces it · /critical-areas clear removes it'].join('\n')
}

function systemSection(c: Config): string {
  return [
    '# Critical decisions',
    `The user marked these as critical in this project: "${c.description}".`,
    `Areas: ${c.areas.map(a => a.name).join(', ')}.`,
    'Whenever, mid-task, you decide something in one of these areas that the user did not literally ask for (a formula, a rule, a status flow, a schema, a default), call the record_decision tool with the decision, the reason and the alternative you ruled out, and mention it in your reply. A change the user asked for word for word needs no record.',
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
  const warned = new Set<string>() // per turn

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    config = ((await $.store.get(storeKey(cwd))) as Config | undefined) ?? undefined
    const reg = (await $.tool.register({
      name: 'record_decision',
      description:
        'Record every decision you make mid-task, without the user asking for it literally, that changes something the user marked as critical in this project (see "Critical decisions" in the system prompt). The user is warned right away.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'The critical area it touches, or "other".' },
          decision: { type: 'string', description: 'What you decided, in one sentence.' },
          reason: { type: 'string', description: 'Why.' },
          alternative_ruled_out: { type: 'string', description: 'What you considered and did not do.' },
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
    return { text: `Saved for ${cwd}.\n\n${describeConfig(config)}` }
  })

  on('prompt.compose', async (_$, e, next) => {
    const r = await next(e)
    if (!config) return r
    return { ...r, sections: [...r.sections, { id: `${PLUGIN}:rules`, text: systemSection(config), scope: 'session' as const }] }
  })

  on('command.run', { command: 'critical-list' }, () => ({ text: report(decisions) }))

  on('command.run', { command: 'critical-ok' }, $ => {
    const n = pending.length
    pending = []
    $.ui.invalidate('ui.render')
    return { text: n ? `${n} decision(s) dismissed. /critical-list still lists them all.` : 'Nothing to dismiss.' }
  })

  // The band stays until dismissed: a toast goes away by itself, this does not.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || pending.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
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
    const d: Decision = {
      time: new Date().toTimeString().slice(0, 5),
      area: String(i.area ?? 'other'),
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
