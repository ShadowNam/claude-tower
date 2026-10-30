import { expect, test } from 'claude-code/testing'

import { capsule, mark, orb } from '../hooks/ui/art'
import { layoutOf } from '../hooks/core/usage'

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

test('a capsule stays linear all the way down, not just above 12%', async () => {
  // The travel is the track less a unit of inset either side.
  const widthOf = (svg: string) => Number(/width="([\d.]+)" height="16" fill="url\(#\w+b\)"/.exec(svg)?.[1] ?? -1)

  expect(widthOf(capsule(100, '#e8893c'))).toBe(164)
  expect(widthOf(capsule(50, '#e8893c'))).toBe(82)

  // The reason for the square-ended fill clipped to a rounded track: a rounded
  // fill shorter than its own corner diameter stops encoding the value. These
  // four used to land on the same lens shape; now each is its own length.
  const low = [8, 5, 3, 1].map(p => widthOf(capsule(p, '#e8893c')))
  expect(low).toEqual([13.12, 8.2, 4.92, 1.64])
  // Strictly decreasing, which is the whole claim.
  expect(low.every((w, i) => i === 0 || w < (low[i - 1] as number))).toBe(true)
})

test('the empty track is visible, so the scale can be read', async () => {
  // Without a rim the track sits at 1.17:1 on the band and a low reading is a
  // nub floating in nothing. EMPTY is 1.77:1 and is what the rim is drawn in.
  const svg = capsule(8, '#e8893c')
  expect(svg).toContain('stroke="#4a463f"')
  expect(svg).toContain('stroke-width="2"')
  // Inset by half the stroke, since SVG strokes straddle the path.
  expect(svg).toContain('x="3" y="7" width="162" height="14"')
})

test("a drawing carries its own floor rather than borrowing the band's", async () => {
  // Alpha over whatever is behind inverts the moment something else is behind
  // it. The floor is opaque, derived from BG.
  const svg = capsule(50, '#e8893c')
  const floor = /<linearGradient id="\w+f"[\s\S]*?<\/linearGradient>/.exec(svg)?.[0] ?? ''
  expect(floor).not.toContain('stop-opacity')
  expect(/stop-color="#[0-9a-f]{6}"/.test(floor)).toBe(true)
})

test('the lit face is darker at its very top than just below it', async () => {
  // The one thing that separates a modelled surface from a cheap gradient: the
  // topmost sliver is the edge rolling away from the light.
  const svg = capsule(60, '#e8893c')
  const body = /<linearGradient id="\w+b"[\s\S]*?<\/linearGradient>/.exec(svg)?.[0] ?? ''
  const lum = (h: string) => {
    const n = parseInt(h.slice(1), 16)
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }
  const stops = [...body.matchAll(/offset="([\d.]+)" stop-color="(#[0-9a-f]{6})"/g)]
  expect(stops.length).toBe(5)
  const lip = lum(stops[0]![2] as string)
  const specular = lum(stops[1]![2] as string)
  expect(lip < specular).toBe(true)
})

test('no feature is thinner than one device pixel at 1x', async () => {
  // Authored at 2x, shown at 1x: a 1-unit line is half a pixel, which renders
  // as mud rather than as a faint line.
  for (const svg of [capsule(62, '#e8893c'), orb('#86c06a'), orb('#e8635a', 'alert'), mark('#e8893c')]) {
    for (const [, w] of svg.matchAll(/<rect[^>]*?width="([\d.]+)"/g)) {
      expect(Number(w) >= 2 || Number(w) === 1).toBe(true) // 1 only inside the dither pattern
    }
    for (const [, sw] of svg.matchAll(/stroke-width="([\d.]+)"/g)) {
      expect(Number(sw) >= 2).toBe(true)
    }
  }
})

test('the failure state has a silhouette, not only a colour', async () => {
  // Green and red are the one pair no hex separates for a deuteranope, so the
  // distinction cannot rest on hue at eleven pixels.
  expect(orb('#86c06a')).toContain('<circle')
  expect(orb('#e8635a', 'alert')).toContain('<path d="M11 3L19 11L11 19L3 11Z"')
  expect(orb('#e8635a', 'alert')).not.toContain('r="8"')
})

test('a colour that is not a colour cannot become markup', async () => {
  const hostile = capsule(50, 'red; }</style><script>alert(1)</script>')
  expect(hostile).not.toContain('<script')
  expect(hostile).not.toContain('</style>')
  expect(hostile).toContain('#888888')
  expect(capsule(50, '#e83')).toContain('#ee8833')
})

test('two drawings in one row never share a gradient id', async () => {
  const a = capsule(40, '#e8954a')
  const b = capsule(40, '#e8c84a')
  const idOf = (s: string) => /id="(t[0-9a-z]+)b"/.exec(s)?.[1]
  expect(idOf(a) !== undefined).toBe(true)
  expect(idOf(a)).not.toBe(idOf(b))
})

test('the drawn surfaces get meters, the terminal keeps its dots', { options: { bandLayout: 'rows' } }, async ($, on) => {
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
  // An alt is only useful if it describes its own drawing. A bulk edit once
  // left the running-agents orb saying "warm", which a presence check missed.
  const alts = drawings.map(altOf)
  expect(alts).toContain('Tower')
  expect(alts.filter(a => typeof a === 'string' && a.endsWith('% left')).length).toBe(2)
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

test('only a running thing moves, and never when motion is unwelcome', async () => {
  // Animation is for liveness. A stalled or finished run is exactly what must
  // NOT move, because movement reads as progress.
  const alive = orb('#86c06a', 'round', true)
  const still = orb('#86c06a', 'round', false)

  expect(alive).toContain('@keyframes')
  expect(alive).toContain('prefers-reduced-motion: reduce')
  expect(still).not.toContain('@keyframes')
  expect(still).not.toContain('class=')

  // The keyframe name is per-drawing, or two orbs in one row share a timeline.
  const nameOf = (s: string) => /@keyframes (\w+)/.exec(s)?.[1]
  expect(nameOf(alive)).not.toBe(nameOf(orb('#58b0cf', 'round', true)))
})

test('a title is what a hover reads, and cannot carry markup out', async () => {
  const titled = capsule(62, '#e8893c', '7D: 62% left, 5d 9h')
  expect(titled).toContain('<title>7D: 62% left, 5d 9h</title>')
  // No title, no element: a tooltip of nothing is worse than none.
  expect(capsule(62, '#e8893c')).not.toContain('<title>')
  // A title is text from elsewhere, so it is stripped before it is markup.
  expect(capsule(62, '#e8893c', '</title><script>x</script>')).not.toContain('<script')
})

test('a shape is seated by a shadow that degrades to nothing visible', async () => {
  // Filters render here — checked with a probe, not assumed. They do one job:
  // seating a shape on the bar. Everything soft inside a drawing is still a
  // gradient to transparent, which on a circle or pill is an exact blur.
  for (const svg of [capsule(62, '#e8893c'), orb('#86c06a'), mark('#e8893c')]) {
    expect(svg).toContain('feGaussianBlur')
    // The region override is required, or the default box clips the blur
    // before it can show.
    expect(svg).toContain('x="-50%" y="-50%" width="200%" height="200%"')
  }

  // The shadow is drawn BEFORE the shape it seats, so a surface that drops
  // filters is left with a hard edge behind rather than a missing element.
  const svg = orb('#86c06a')
  expect(svg.indexOf('filter="url(#') < svg.indexOf('<circle cx="11" cy="11" r="8"')).toBe(true)

  // And it stays under a device pixel: further down and it reads as a sticker.
  for (const [, dy] of svg.matchAll(/feOffset dy="([\d.]+)"/g)) {
    expect(Number(dy) <= 2).toBe(true)
  }
})

test('each layout draws what it promises, and the terminal always gets rows', async ($, on) => {
  const mount = async (surface: 'terminal' | 'desktop') =>
    $.ui.mount({ ...BAND, surface })

  SEED(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Dials is the default. The figure moves inside the drawing, so the band has
  // one Svg per window plus the mark, and no "% left" text of its own.
  const desktop = await mount('desktop')
  expect((await desktop.findAll({ type: 'Svg' })).length).toBe(3)
  expect(await desktop.find({ type: 'Text', text: /% left/ })).toBe(undefined)
  // The dial still says what it is, for anyone who cannot see it.
  expect((await desktop.findAll({ type: 'Svg' })).some(d => /7D 69% left/.test(String(altOf(d))))).toBe(true)
  await desktop.unmount()

  // The terminal can draw neither a dial nor a tile, so it keeps rows however
  // the setting reads — an arc made of text is a worse bar, not a dial.
  const term = await mount('terminal')
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
  expect((await term.find({ type: 'Text', text: /69% left/ }))?.text).toBe(' 69% left')
  await term.unmount()
})

test('an unknown layout falls back rather than drawing nothing', async () => {
  expect(layoutOf('dials')).toBe('dials')
  expect(layoutOf('hero')).toBe('hero')
  expect(layoutOf('cards')).toBe('cards')
  expect(layoutOf('rows')).toBe('rows')
  // A setting from an older version, or a typo, must not blank the band.
  expect(layoutOf('sparkline')).toBe('dials')
  expect(layoutOf(undefined)).toBe('dials')
  expect(layoutOf(7)).toBe('dials')
})
