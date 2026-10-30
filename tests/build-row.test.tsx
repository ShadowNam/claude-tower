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

/** Every hook here stands for the engine: nothing sits beneath the mod. */
const seat = (on: Parameters<Parameters<typeof test>[1]>[1]): void => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/src/web-app' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 0, window: 1_000_000 } } }))
  on('command.register', () => ({ value: { command: 'tower' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('fs.read', () => ({ value: '{"name":"web-app","version":"2.4.1"}' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

test('a finished build names itself and its version', async ($, on) => {
  seat(on)
  on('tool.call', () => ({ result: 'done' }))

  await $.session.start({ cwd: '/src/web-app', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'b1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /BUILD/ }))?.text).toBe('BUILD')
  expect((await ui.find({ type: 'Text', text: /built/ }))?.text).toBe('✓ built')
  expect((await ui.find({ type: 'Text', text: /2\.4\.1/ }))?.text).toBe('web-app 2.4.1 · npm run build')
  await ui.unmount()
})

test('a failed build shows the first error line', async ($, on) => {
  seat(on)
  on('tool.call', () => ({
    isError: true,
    result: '> web-app@2.4.1 build\nsrc/lib/cart.ts(42,9): error TS2345: Argument of type string',
  }))

  await $.session.start({ cwd: '/src/web-app', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'b1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toBe('✗ failed')
  expect((await ui.find({ type: 'Text', text: /TS2345/ }))?.text).toBe(
    'src/lib/cart.ts(42,9): error TS2345: Argument of type string',
  )
  await ui.unmount()
})

test('a command that is not a build takes no row', async ($, on) => {
  seat(on)
  on('tool.call', () => ({ result: 'a b c' }))

  await $.session.start({ cwd: '/src/web-app', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls -la', tool_use_id: 'b1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /BUILD/ })).toBe(undefined)
  await ui.unmount()
})

test('with the build bar off, a build is not tracked', { options: { buildBar: false } }, async ($, on) => {
  seat(on)
  on('tool.call', () => ({ result: 'done' }))

  await $.session.start({ cwd: '/src/web-app', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'b1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /BUILD/ })).toBe(undefined)
  await ui.unmount()
})
