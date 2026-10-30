import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'tower',
  component: 'Pane',
  requestId: 'tower-agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
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
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 0, window: 1_000_000 } } }))
  on('command.register', () => ({ value: { command: 'tower-agents' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

test('an empty session says so rather than drawing an empty panel', async ($, on) => {
  seat(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No agents/ }))?.text).toBe(
    'No agents have run in this session yet.',
  )
  await ui.unmount()
})

test('a spawned agent takes a row, with its model', async ($, on) => {
  seat(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-5-5' }))

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

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /map the repo/ }))?.text).toBe('map the repo')
    expect((await ui.find({ type: 'Text', text: /opus/ }))?.text).toBe('opus-5-5')
    expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toBe('1 running')
    await ui.unmount()
  }
})

test('a tool call shows on the row that is running it', async ($, on) => {
  seat(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-opus-5-5' }))
  // The tool itself does nothing here; the row is drawn while it runs.
  on('tool.call', () => ({ result: {} }))

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
  await $.tool.call({ tool: 'Edit', file_path: 'src/app.ts', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The call has finished, so the row shows what it left behind, not the tool.
  // The leading space is the tree indent: this run sits one level under main.
  expect((await ui.find({ type: 'Text', text: /touched/ }))?.text).toBe('    1 file touched')
  await ui.unmount()
})
