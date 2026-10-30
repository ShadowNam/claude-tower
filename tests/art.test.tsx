import { expect, test } from 'claude-code/testing'

import { mark, meter } from '../hooks/ui/art'

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

test('a meter is bounded markup whose fill follows the figure', async () => {
  const full = meter(100, '#e8954a', '#4a463f')
  const half = meter(50, '#e8954a', '#4a463f')
  const none = meter(0, '#e8954a', '#4a463f')

  for (const svg of [full, half, none]) {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    // A drawing carries no script and no text of its own.
    expect(/<script|<text|onload=/i.test(svg)).toBe(false)
  }

  // Empty draws the track alone; half draws a bar half the track's width.
  expect(none.match(/<rect/g)?.length).toBe(1)
  expect(half).toContain('width="38.00"')
  expect(full).toContain('width="76.00"')

  // A reading outside the scale cannot overdraw the track.
  expect(meter(140, '#e8954a', '#4a463f')).toContain('width="76.00"')
  expect(meter(Number.NaN, '#e8954a', '#4a463f').match(/<rect/g)?.length).toBe(1)

  // A colour that is not a colour never reaches the markup.
  expect(meter(50, 'red; }</style><script>x', '#4a463f')).not.toContain('<script')
  expect(mark('#e8954a')).toContain('#e8954a')
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
