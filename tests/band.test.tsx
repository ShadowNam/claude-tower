import { expect, test } from 'claude-code/testing'

import { layoutOf, nextLayout } from '../hooks/core/usage'

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

/** A fixed clock, so a countdown reads the same on every run. */
const NOW = 1_800_000_000_000

const WINDOWS = [
  { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString() },
  { kind: 'five_hour', percentUsed: 15, resetsAt: new Date(NOW + 21 * 60_000).toISOString() },
]

test('the band draws each window with what is left of it', { options: { bandLayout: 'rows' } }, async ($, on) => {
  // Nothing sits beneath the mod: each hook here stands for the engine.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.usage', () => ({ value: { rateLimits: WINDOWS, context: { tokens: 322_000, window: 1_000_000 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Button', label: /^USAGE / })) !== undefined).toBe(true)
    // 31% used of the seven-day window leaves 69.
    expect((await ui.find({ type: 'Text', text: /69% left/ }))?.text).toBe(' 69% left')
    expect((await ui.find({ type: 'Text', text: /85% left/ }))?.text).toBe(' 85% left')
    // The five-hour window resets in 21 minutes. It is the supporting column
    // here, not the hero: at 85% left and not running out, the 7-day window at
    // 69% is the one that will stop you first.
    expect((await ui.find({ type: 'Text', text: /21m/ }))?.text).toBe(' · 21m')
    // Another mod's band keeps its place underneath this one.
    expect((await ui.find({ type: 'Text', text: /beneath/ }))?.text).toBe('beneath')

    await ui.unmount()
  }
})

test('a window running out says so', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.usage', () => ({
    value: {
      rateLimits: [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(NOW + 60 * 60_000).toISOString() }],
      context: { tokens: 10, window: 1_000_000 },
    },
  }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /LOW/ }))?.text).toBe(' LOW ')
  await ui.unmount()
})

test('with nothing measured the band takes no row', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 0, window: 0 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /USAGE/ })).toBe(undefined)
  // The row belongs to whoever else wants it.
  expect((await ui.find({ type: 'Text', text: /beneath/ }))?.text).toBe('beneath')
  await ui.unmount()
})

test('a switched-off band draws nothing at all', { options: { usageBand: false } }, async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.usage', () => ({ value: { rateLimits: WINDOWS, context: { tokens: 322_000, window: 1_000_000 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /USAGE/ })).toBe(undefined)
  await ui.unmount()
})

test('the band names the layout it is drawing, and cycles on a press', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('session.usage', () => ({ value: { rateLimits: WINDOWS, context: { tokens: 1, window: 200_000 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('store.get', (_, e) => ({ value: kept[String((e as { key?: unknown }).key)] ?? null }))
  on('store.set', (_, e) => {
    const row = e as { key: string; value: unknown }
    kept[row.key] = row.value
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // The control is the band's own label, so it costs no columns of its own,
  // and the layout it is drawing is written beside it.
  expect((await ui.find({ type: 'Button', label: /^USAGE / })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', label: 'USAGE dials' })) !== undefined).toBe(true)

  // A press writes state, so the band redraws, and the store, so the choice
  // outlives the session. It used to call config.set, which answers { deny }
  // rather than throwing when the row is not the plugin's to write — and the
  // press ignored the answer, so a refusal looked like a dead button.
  await ui.press({ key: 'cycle' })
  expect(kept['layout']).toBe('hero')
  expect((await ui.find({ type: 'Button', label: 'USAGE hero' })) !== undefined).toBe(true)

  await ui.press({ key: 'cycle' })
  expect(kept['layout']).toBe('cards')
  await ui.unmount()
})

test('cycling visits every layout and comes back', async () => {
  // Four presses from any starting point return you to where you began, so
  // the control can never strand you somewhere you cannot get out of.
  let at: ReturnType<typeof layoutOf> = 'dials'
  const seen = [at]
  for (let i = 0; i < 4; i++) {
    at = nextLayout(at)
    seen.push(at)
  }
  expect(seen).toEqual(['dials', 'hero', 'cards', 'rows', 'dials'])
  expect(new Set(seen).size).toBe(4)
})
