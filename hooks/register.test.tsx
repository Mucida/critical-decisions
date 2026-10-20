import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__critical-decisions__record_decision'
const g: { toasts: string[]; status: string | undefined; store: Map<string, unknown>; modelReply: string | null; asked: string[] } = {
  toasts: [],
  status: undefined,
  store: new Map(),
  modelReply: null,
  asked: [],
}

const AREAS_JSON = JSON.stringify({
  areas: [
    { name: 'pricing', keywords: ['unit_price', 'tax_rate'], paths: ['src/billing/**'] },
    { name: 'migrations', keywords: [], paths: ['**/*.sql'] },
  ],
})

// Bottom of the chain: what the engine would do. Toasts, status, store and model go to g.
const base = (on: any, opts: { fail?: boolean } = {}) => {
  g.toasts = []
  g.status = undefined
  g.store = new Map()
  g.modelReply = AREAS_JSON
  g.asked = []
  on('tool.call', () => (opts.fail ? { isError: true, result: 'failed' } : { result: {}, text: 'ok' }))
  on('ui.toast', (_$: any, e: any) => {
    g.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    g.status = e.text
    return { value: undefined }
  })
  on('store.get', (_$: any, e: any) => ({ value: g.store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    g.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    g.store.delete(e.key)
    return { value: undefined }
  })
  on('model.complete', (_$: any, e: any) => {
    g.asked.push(String(e.prompt))
    return {
      value: g.modelReply === null
        ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }
        : { isAnswered: true, text: g.modelReply, usage: {} },
    }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const COMPOSE: any = { model: 'claude-x', promptModel: 'claude-x', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
const endTurn = ($: any) => $.turn.complete({ answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false } as any)
const start = ($: any, cwd = '/proj') => $.session.start({ cwd } as any)
const cmd = ($: any, command: string, args = '') => $.command.run({ command, args } as any)
const edit = ($: any, file_path: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string })
const configure = async ($: any) => {
  await start($)
  await cmd($, 'critical-areas', 'prices and taxes, anything in src/billing, sql migrations')
}

test('without config nothing is flagged and /critical-areas explains how to set it', async ($, on) => {
  base(on)
  await start($)
  const r = await edit($, '/proj/src/billing/a.ts', 'unit_price = 2')
  expect(g.toasts.length).toBe(0)
  expect(r.context).toBe(undefined)
  const shown = await cmd($, 'critical-areas')
  expect(shown.text.includes('/critical-areas <'), shown.text).toBe(true)
})

test('/critical-areas turns the text into areas, saves it per project, and shows it', async ($, on) => {
  base(on)
  await configure($)
  expect(g.asked[0].includes('src/billing'), 'the person text goes to the model').toBe(true)
  expect(g.store.has('config:/proj'), 'saved under the cwd').toBe(true)
  const shown = await cmd($, 'critical-areas')
  expect(shown.text.includes('pricing') && shown.text.includes('src/billing/**'), shown.text).toBe(true)
})

test('config survives a new session in the same project, not in another', async ($, on) => {
  base(on)
  await configure($)
  await start($, '/proj')
  await edit($, '/proj/src/billing/x.ts', 'y')
  expect(g.toasts.length, 'same project').toBe(1)
  await start($, '/other')
  await edit($, '/other/src/billing/x.ts', 'y')
  expect(g.toasts.length, 'other project').toBe(1)
})

test('path or keyword match warns the person and reminds the agent', async ($, on) => {
  base(on)
  await configure($)
  for (const [f, t] of [
    ['/proj/src/billing/cart.ts', 'const x = 1'],
    ['/proj/src/api/order.py', 'total = qty * unit_price'],
    ['/proj/db/0042_add.sql', 'alter table x'],
  ]) {
    await endTurn($)
    g.toasts = []
    const r = await edit($, f, t)
    expect(g.toasts.length, f).toBe(1)
    expect(String(r.context?.[0]).includes(TOOL), f).toBe(true)
  }
})

test('unrelated edits stay quiet', async ($, on) => {
  base(on)
  await configure($)
  await edit($, '/proj/src/ui/Button.tsx', 'const label = "ok"')
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/billing/a.ts' } as any)
  expect(g.toasts.length).toBe(0)
})

test('prose counts: a writing project is matched by keyword too', async ($, on) => {
  base(on)
  await configure($)
  await edit($, '/proj/drafts/article.md', 'the unit_price went up')
  expect(g.toasts.length).toBe(1)
})

test('shell commands and MCP tools are matched by keyword, never by path, and the own tool is ignored', async ($, on) => {
  base(on)
  await configure($)
  await $.tool.call({ tool: 'Bash', command: 'ls src/billing' } as any)
  expect(g.toasts.length, 'a path in a command is not a path match').toBe(0)
  await $.tool.call({ tool: 'Bash', command: "psql -c 'update items set unit_price = 3'" } as any)
  expect(g.toasts.length, 'bash keyword').toBe(1)
  await endTurn($)
  await $.tool.call({ tool: 'mcp__shop__update_product', fields: { tax_rate: 0.2 } } as any)
  expect(g.toasts.length, 'mcp keyword').toBe(2)
  await endTurn($)
  await $.tool.call({ tool: TOOL, area: 'pricing', decision: 'set tax_rate', reason: 'r' } as any)
  expect(g.toasts.filter(t => t.startsWith('⚠️ Critical area')).length, 'own tool').toBe(2)
})

test('a failed edit does not warn', async ($, on) => {
  base(on, { fail: true })
  await configure($)
  await edit($, '/proj/src/billing/a.ts', 'x')
  expect(g.toasts.length).toBe(0)
})

test('keyword needs a word start: "subunit_prices" style substrings inside words do not match', async ($, on) => {
  base(on)
  await configure($)
  await edit($, '/proj/src/a.ts', 'const myunit_price_label = 1')
  expect(g.toasts.length).toBe(0)
})

test('same area warns once per turn', async ($, on) => {
  base(on)
  await configure($)
  await edit($, '/proj/src/billing/a.ts', 'x')
  await edit($, '/proj/src/billing/b.ts', 'y')
  expect(g.toasts.length, 'same turn').toBe(1)
  await endTurn($)
  await edit($, '/proj/src/billing/c.ts', 'z')
  expect(g.toasts.length, 'new turn').toBe(2)
})

test('the system prompt always carries the default criteria; config adds the person\'s areas', async ($, on) => {
  base(on)
  await start($)
  let r = await $.prompt.compose(COMPOSE)
  let s = r.sections.find((s: any) => s.id === 'critical-decisions:rules') as any
  expect(s?.scope, 'session section').toBe('session')
  expect(s.text.includes('did not ask for') && s.text.includes('CLAUDE.md') && s.text.includes('record_decision'), s.text).toBe(true)
  expect(s.text.includes('has not said what is critical'), 'says it is the default').toBe(true)
  await cmd($, 'critical-areas', 'prices and taxes')
  r = await $.prompt.compose(COMPOSE)
  s = r.sections.find((s: any) => s.id === 'critical-decisions:rules') as any
  expect(s.text.includes('prices and taxes') && s.text.includes('pricing') && s.text.includes('did not ask for'), s.text).toBe(true)
  expect(s.text.includes('has not said'), 'no default-only line once configured').toBe(false)
})

test('model failure or unreadable answer saves nothing and keeps the old config', async ($, on) => {
  base(on)
  await configure($)
  g.modelReply = null
  let r = await cmd($, 'critical-areas', 'something else')
  expect(r.text.startsWith('Nothing saved'), r.text).toBe(true)
  g.modelReply = 'sorry, I cannot'
  r = await cmd($, 'critical-areas', 'something else')
  expect(r.text.startsWith('Nothing saved'), r.text).toBe(true)
  expect((await cmd($, 'critical-areas')).text.includes('pricing'), 'old config kept').toBe(true)
})

test('the description can be in any language and goes to the model as written', async ($, on) => {
  base(on)
  await start($)
  const r = await cmd($, 'critical-areas', 'preço, impostos e tudo em src/billing')
  expect(g.asked[0], 'sent as written').toBe('preço, impostos e tudo em src/billing')
  expect(r.text.includes('preço, impostos'), r.text).toBe(true)
  await cmd($, 'critical-areas', 'limpar')
  expect(g.store.has('config:/proj'), '"limpar" clears too').toBe(false)
})

test('/critical-areas clear removes it', async ($, on) => {
  base(on)
  await configure($)
  await cmd($, 'critical-areas', 'clear')
  expect(g.store.has('config:/proj')).toBe(false)
  await edit($, '/proj/src/billing/a.ts', 'x')
  expect(g.toasts.length).toBe(0)
})

test('record_decision warns the person and /critical-list lists it', async ($, on) => {
  base(on)
  await start($)
  const r = await $.tool.call({
    tool: TOOL,
    area: 'pricing',
    decision: 'Rounded tax to 2 decimals',
    reason: 'match the invoice',
    alternative_ruled_out: 'keep 4 decimals',
  } as any)
  expect(String(r.result).includes('recorded'), 'result').toBe(true)
  expect(g.toasts[0].includes('CRITICAL DECISION'), 'toast').toBe(true)
  expect(String(g.status).includes('Rounded'), 'status').toBe(true)
  const list = await cmd($, 'critical-list')
  expect(list.text.includes('keep 4 decimals'), 'list').toBe(true)
})

const PROPS: any = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { bodyRows: 10 }, view: {} }
const band = ($: any) => $.ui.mount({ plugin: 'critical-decisions', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('|')
const decide = ($: any, decision: string) => $.tool.call({ tool: TOOL, area: 'pricing', decision, reason: 'r' } as any)

test('decision stays on the band across turns and prompts until ok', async ($, on) => {
  base(on)
  await start($)
  await decide($, 'Rounded tax')
  await endTurn($)
  await $.prompt.submit({ text: 'next' } as any)
  let ui = await band($)
  expect((await texts(ui)).includes('Rounded tax'), await texts(ui)).toBe(true)
  await ui.press({ key: 'ok' })
  ui = await band($)
  expect((await texts(ui)).includes('Rounded'), 'gone after ok').toBe(false)
  expect((await cmd($, 'critical-list')).text.includes('Rounded tax'), '/critical-list still lists').toBe(true)
})

test('/critical-ok also clears; many decisions show the last 3 and count the rest', async ($, on) => {
  base(on)
  await start($)
  for (const n of ['d1', 'd2', 'd3', 'd4', 'd5']) await decide($, n)
  const t = await texts(await band($))
  expect(t.includes('5 critical decisions'), t).toBe(true)
  expect(t.includes('d5') && t.includes('d3') && !t.includes('d2'), t).toBe(true)
  expect(t.includes('+2'), t).toBe(true)
  const r = await cmd($, 'critical-ok')
  expect(r.text.includes('5'), r.text).toBe(true)
  expect((await texts(await band($))).includes('decision'), 'empty').toBe(false)
})

test('record_decision without a decision or reason records nothing and says how to fix it', async ($, on) => {
  base(on)
  await start($)
  const r = await $.tool.call({ tool: TOOL, area: 'pricing', decision: ' ', reason: 'r' } as any)
  expect(r.isError, 'error').toBe(true)
  expect(String(r.result).includes('again'), String(r.result)).toBe(true)
  expect(g.toasts.length).toBe(0)
  await $.tool.call({ tool: TOOL, decision: 'Added a comparison', reason: 'context' } as any)
  expect((await cmd($, 'critical-list')).text.includes('(general)'), 'area defaults to general').toBe(true)
})

test('first use shows the default-protection notice until ok, once per project', async ($, on) => {
  base(on)
  await start($)
  let ui = await band($)
  expect((await texts(ui)).includes('default protection'), await texts(ui)).toBe(true)
  await ui.press({ key: 'ok' })
  expect((await texts(await band($))).includes('default protection'), 'gone after ok').toBe(false)
  expect(g.store.get('notice-seen:/proj'), 'remembered').toBe(true)
  await start($, '/proj')
  expect((await texts(await band($))).includes('default protection'), 'not again in this project').toBe(false)
  await start($, '/other')
  expect((await texts(await band($))).includes('default protection'), 'shown in another project').toBe(true)
})

test('configuring or /critical-ok takes the notice down; a configured project never shows it', async ($, on) => {
  base(on)
  await start($)
  await cmd($, 'critical-areas', 'prices')
  expect((await texts(await band($))).includes('default protection'), 'configured').toBe(false)
  await start($, '/other')
  await cmd($, 'critical-ok')
  expect((await texts(await band($))).includes('default protection'), 'critical-ok').toBe(false)
  await start($, '/proj')
  expect((await texts(await band($))).includes('default protection'), 'configured project on restart').toBe(false)
})

test('without config /critical-areas explains the default protection', async ($, on) => {
  base(on)
  await start($)
  const t = (await cmd($, 'critical-areas')).text
  expect(t.includes('Default protection') && t.includes('/critical-areas <your words>'), t).toBe(true)
})
