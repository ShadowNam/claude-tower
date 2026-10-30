import { expect, test } from 'claude-code/testing'

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

const SEED = (on: Parameters<Parameters<typeof test>[2]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: { id: 'claude-opus-5', displayName: 'Opus 5' } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

/**
 * The state a session is in the moment the mod loads: the engine knows the
 * context being carried, but has handed over no rate-limit windows, and no
 * turn has run so the prompt cache has never been stamped. The band used to
 * draw nothing here, which is indistinguishable from the mod not loading.
 */
test('with figures but no windows yet the band still holds its row', async ($, on) => {
  SEED(on)
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 322_000, window: 1_000_000 } } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Button', label: 'USAGE' })) !== undefined).toBe(true)
    // The context it is carrying is shown whatever the width, being all there is.
    expect((await ui.find({ type: 'Text', text: /32%/ }))?.text).toBe('32%')
    // And it says plainly that the windows are the missing part.
    expect((await ui.find({ type: 'Text', text: /not measured yet/ }))?.text).toContain('/tower')
    expect((await ui.find({ type: 'Text', text: /beneath/ }))?.text).toBe('beneath')
    await ui.unmount()
  }
})

/** Narrow terminals get the same single row, not a stacked one with a hole in it. */
test('the bare row survives a narrow terminal', async ($, on) => {
  SEED(on)
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 50_000, window: 200_000 } } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 60 } })
  expect((await ui.find({ type: 'Button', label: 'USAGE' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /25%/ }))?.text).toBe('25%')
  await ui.unmount()
})
