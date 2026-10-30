import { expect, test } from 'claude-code/testing'

const NOW = 1_800_000_000_000

/**
 * A feature that throws while starting used to take the rest of the mod with
 * it: boot.ts ran the fan-out under one shared catch, so a usage seed that
 * failed left the agents panel unregistered and nothing on screen to say why.
 *
 * `session.usage` is deliberately left unstubbed here, which makes the call
 * throw the way an engine that cannot answer it would.
 */
test('a feature that fails to start is skipped alone, not with the rest', async ($, on) => {
  const registered: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: { id: 'claude-opus-5', displayName: 'Opus 5' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // The usage seed threw, and the features after it still started.
  expect(registered).toContain('tower')
  expect(registered).toContain('tower-agents')

  // And `/tower` says which one did not, so a missing band has a reason.
  const { text } = await $.command.run({ command: 'tower' })
  expect(text).toContain('did not start')
  expect(text).toContain('usage:')
})

/** With everything answering, nothing is reported as broken. */
test('a clean load reports no failures', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', base: 'test', builtAt: '' } }))
  on('session.model', () => ({ value: { id: 'claude-opus-5', displayName: 'Opus 5' } }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 10, window: 200_000 } } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const { text } = await $.command.run({ command: 'tower' })
  expect(text).toContain('Tower v2.5.0')
  expect(text).not.toContain('did not start')
})
