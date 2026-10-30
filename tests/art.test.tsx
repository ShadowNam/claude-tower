import { expect, test } from 'claude-code/testing'

import { capsule, mark, orb } from '../hooks/ui/art'

const BAND = {
  plugin: 'tower',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const NOW = 1_800_000_000_000
const WINDOWS = [
  { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString() },
  { kind: 'five_hour', percentUsed: 15, resetsAt: new Date(NOW + 21 * 60_000).toISOString() },
]

const SEED = (on: Parameters<Parameters<typeof test>[2]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: { id: 'claude-opus-5', displayName: 'Opus 5' } }))
  on('session.usage', () => ({ value: { rateLimits: WINDOWS, context: { tokens: 1, window: 200_000 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
}

test('every drawing is bounded markup carrying no text and no script', async () => {
  const drawings = [capsule(62, '#e8954a'), capsule(0, '#e8954a'), orb('#7fb069'), mark('#e8954a')]
  for (const svg of drawings) {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(/<script|<text|onload=|href=/i.test(svg)).toBe(false)
    // Drawn at 2x and shown at 1x, so a gradient has pixels to resolve in.
    expect(/viewBox="0 0 \d+ \d+" width="\d+" height="\d+"/.test(svg)).toBe(true)
  }
})

test('a capsule fills to the figure and never past its track', async () => {
  // 84 wide at 2x, less a pixel of inset either side: 166 of travel.
  expect(capsule(100, '#e8954a')).toContain('width="166.00"')
  expect(capsule(50, '#e8954a')).toContain('width="83.00"')
  // Out of scale, and not a number at all, both stop at the ends.
  expect(capsule(140, '#e8954a')).toContain('width="166.00"')
  // Nothing left means no bead at all: the channel alone, one rect.
  expect(capsule(-20, '#e8954a').match(/<rect/g)?.length).toBe(1)
  expect(capsule(Number.NaN, '#e8954a').match(/<rect/g)?.length).toBe(1)
  // And a real reading draws the bead, its specular and its rim.
  expect(capsule(50, '#e8954a').match(/<rect/g)?.length).toBe(4)
})

test('a colour that is not a colour cannot become markup', async () => {
  // Only ever three integers reach the file, whatever was handed in.
  const hostile = capsule(50, 'red; }</style><script>alert(1)</script>')
  expect(hostile).not.toContain('<script')
  expect(hostile).not.toContain('</style>')
  expect(hostile).toContain('rgb(136,136,136)')
  expect(capsule(50, '#e84')).toContain('rgb(238,136,68)')
  expect(mark('#e8954a')).toContain('rgb(')
})

test('two drawings in one row never share a gradient id', async () => {
  const a = capsule(40, '#e8954a')
  const b = capsule(40, '#e8c84a')
  const idOf = (s: string) => /id="(t[0-9a-z]+)b"/.exec(s)?.[1]
  expect(idOf(a) !== undefined).toBe(true)
  expect(idOf(a)).not.toBe(idOf(b))
})

test('the drawn surfaces get meters, the terminal keeps its dots', async ($, on) => {
  SEED(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The mark and one meter per window.
  expect((await desktop.findAll({ type: 'Svg' })).length).toBe(3)
  expect((await desktop.find({ type: 'Svg', alt: 'Tower' })) !== undefined).toBe(true)
  // The figure is still written out, so the drawing is never the only account.
  expect((await desktop.find({ type: 'Text', text: /69% left/ }))?.text).toBe(' 69% left')
  await desktop.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
  // Dots carry it there instead.
  expect((await term.find({ type: 'Text', text: /●/ })) !== undefined).toBe(true)
  expect((await term.find({ type: 'Text', text: /69% left/ }))?.text).toBe(' 69% left')
  await term.unmount()
})

/**
 * An Svg with an empty alt is dropped by the surface and the row draws on
 * without it — nothing fails, the drawing is simply absent. That is how the
 * cache orb shipped missing in 2.0.0, so the alt is asserted on every drawing
 * rather than assumed.
 */
const altOf = (d: unknown): unknown =>
  (d as { alt?: unknown }).alt ?? (d as { props?: { alt?: unknown } }).props?.alt

const says = (d: unknown): boolean => {
  const alt = altOf(d)
  return typeof alt === 'string' && alt.trim() !== ''
}

test('every drawing on the band says what it is', async ($, on) => {
  SEED(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const drawings = await ui.findAll({ type: 'Svg' })

  // The mark, and a capsule for each window.
  expect(drawings.length).toBe(3)
  expect(drawings.every(says)).toBe(true)
  await ui.unmount()
})

test('every drawing in the agents panel says what it is', async ($, on) => {
  SEED(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-5-5' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    subagentType: 'Explore',
    description: 'map the repo',
    prompt: 'go',
    tool_use_id: 't1',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  const ui = await $.ui.mount({
    plugin: 'tower',
    component: 'Pane',
    requestId: 'tower-agents',
    surface: 'desktop',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  const drawings = await ui.findAll({ type: 'Svg' })
  // A running agent gets a status orb; this is the orb path the band could
  // not reach from a test, since turn.step cannot be driven from one.
  expect(drawings.length > 0).toBe(true)
  expect(drawings.every(says)).toBe(true)
  expect(drawings.some(d => altOf(d) === 'running')).toBe(true)
  await ui.unmount()
})
