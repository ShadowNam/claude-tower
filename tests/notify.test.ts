import { expect, test } from 'claude-code/testing'

import { reasonOf } from '../hooks/core/fmt'
import { canSend, dayOf, decide, EMPTY_POLICY, inQuietHours, levelOf, record, render, wants } from '../hooks/core/notify'

import type { Policy } from '../hooks/core/notify'

const T0 = new Date('2026-10-30T14:22:00').getTime()
const MIN = 60_000

const allow = (policy: Policy, level: string, event: Parameters<typeof decide>[3], subject = 's', now = T0) =>
  decide(policy, level, '', event, subject, now, 0)

test('nothing can send until the switch is on and a gateway is named', async () => {
  expect(canSend({}).ok).toBe(false)
  expect(canSend({ notifyEnabled: true }).ok).toBe(false)
  expect(canSend({ notifyEnabled: true, whatsappServer: 'wa' }).ok).toBe(true)
  // Off is off, whatever else is set.
  expect(canSend({ notifyEnabled: false, whatsappServer: 'wa', notifyLevel: 'debug' }).ok).toBe(false)
})

test('silent is the default and sends nothing at all', async () => {
  expect(levelOf({})).toBe('silent')
  expect(levelOf({ notifyLevel: 'nonsense' })).toBe('silent')

  expect(wants('silent', 'build.failed')).toBe(false)
  expect(wants('silent', 'tank.waiting')).toBe(false)
  expect(allow(EMPTY_POLICY, 'silent', 'build.failed').send).toBe(false)
})

test('milestones carries what needs a person, not what merely happened', async () => {
  expect(wants('milestones', 'build.failed')).toBe(true)
  expect(wants('milestones', 'tank.waiting')).toBe(true)
  expect(wants('milestones', 'ratelimit.hit')).toBe(true)

  // A build that worked is not news at this level.
  expect(wants('milestones', 'build.finished')).toBe(false)
  expect(wants('verbose', 'build.finished')).toBe(true)
})

test('the same thing is not said twice in a row', async () => {
  const sent = record(EMPTY_POLICY, 'build.failed', 'web-app|npm run build', T0)

  // The identical failure, a minute later.
  expect(decide(sent, 'milestones', '', 'build.failed', 'web-app|npm run build', T0 + MIN, 0).send).toBe(false)
  // A different failure, still inside the cooldown for this kind.
  expect(decide(sent, 'milestones', '', 'build.failed', 'api|cargo build', T0 + MIN, 0).send).toBe(false)
  // The same one again much later is worth repeating.
  expect(decide(sent, 'milestones', '', 'build.failed', 'web-app|npm run build', T0 + 45 * MIN, 0).send).toBe(true)
})

test('a session that has said plenty stops saying more', async () => {
  expect(decide(EMPTY_POLICY, 'milestones', '', 'build.failed', 's', T0, 15).send).toBe(false)
  expect(decide({ ...EMPTY_POLICY, day: dayOf(T0), dayCount: 60 }, 'milestones', '', 'build.failed', 's', T0, 0).send).toBe(
    false,
  )
  // Yesterday's count does not hold today back.
  expect(decide({ ...EMPTY_POLICY, day: '2026-10-29', dayCount: 60 }, 'milestones', '', 'build.failed', 's', T0, 0).send).toBe(
    true,
  )
})

test('quiet hours hold everything but the things that mean work has stopped', async () => {
  const night = new Date('2026-10-30T23:30:00').getTime()
  const morning = new Date('2026-10-30T09:00:00').getTime()

  expect(inQuietHours('22:00-07:00', night)).toBe(true)
  expect(inQuietHours('22:00-07:00', new Date('2026-10-30T03:00:00').getTime())).toBe(true)
  expect(inQuietHours('22:00-07:00', morning)).toBe(false)
  expect(inQuietHours('', night)).toBe(false)

  // A finished build waits until morning.
  expect(decide(EMPTY_POLICY, 'verbose', '22:00-07:00', 'build.finished', 's', night, 0).send).toBe(false)
  // Something waiting on an answer does not.
  expect(decide(EMPTY_POLICY, 'milestones', '22:00-07:00', 'tank.waiting', 's', night, 0).send).toBe(true)
})

test('a message is a template filled with local facts, and nothing else', async () => {
  const text = render(
    'build.failed',
    { project: 'web-app', session: '7f3a', detail: 'npm run build', extra: 'src/a.ts(1,1): error TS1005' },
    T0,
  )
  expect(text.startsWith('*Build failed* · web-app · #7f3a')).toBe(true)
  expect(text.includes('14:22')).toBe(true)

  // Anything that looks like a credential never leaves the machine.
  const leaky = render('build.failed', { detail: 'push failed', extra: 'Bearer ghp_abcdefghijk' }, T0)
  expect(leaky.includes('ghp_')).toBe(false)
  expect(leaky.includes('<redacted>')).toBe(true)
})

test('the test message says what it is', async () => {
  expect(render('test', {}, T0).startsWith('*Tower is connected*')).toBe(true)
  // It is the one message that no level gates, because a person asked for it.
  expect(wants('silent', 'test')).toBe(true)
})

test('a gateway refusal is reported whole, including the server it tried', async () => {
  // The engine's own wording when the configured server name resolves to
  // nothing. At 80 characters this was cut before the name, which is the only
  // part that says what to fix.
  const real = new Error(
    '$.mcp.call: no connected MCP tool "whatsapp_send_message" on a server named "WhatsApp Gateway"',
  )
  const reason = reasonOf(real, 600, 'the gateway refused')
  expect(reason).toContain('whatsapp_send_message')
  expect(reason).toContain('WhatsApp Gateway')

  // Anything key-shaped still goes, and a thrown non-error still reads plainly.
  expect(reasonOf(new Error('refused: Bearer ghp_abcdefghijklmnop'), 600, 'the gateway refused')).toBe('refused: Bearer <redacted>')
  expect(reasonOf(new TypeError(''), 600, 'the gateway refused')).toBe('the gateway refused')
  expect(reasonOf(new Error('   '), 600, 'the gateway refused')).toBe('the gateway refused')
})

test('the auto mode refusal survives whole, operative clause and all', async () => {
  // Verbatim from a real send under permissionMode "auto". The clause that
  // says what is wrong sits 160 characters in, after the tool's full name, and
  // the advice runs on well past it.
  const real = new Error(
    'The server-side auto mode classifier gave no verdict for ' +
      'mcp__aa465f29-6c9e-4063-966d-507df8b7208b__whatsapp_send_message: the request that ' +
      'produced this action did not ask for one. Issue the action again once, as-is; if it ' +
      "is denied again, continue with other tasks that don't require it and tell the user " +
      'that auto mode could not evaluate it.',
  )
  const reason = reasonOf(real, 600, 'the gateway refused')
  expect(reason).toContain('did not ask for one')
  expect(reason.endsWith('…')).toBe(false)
})

test('a Tank poll failure cannot carry its bearer token into the panel', async () => {
  // Tank is reached over HTTP with a bearer header, so an error that quotes the
  // request would otherwise be stored and drawn verbatim.
  const leaky = new Error('connect ECONNREFUSED; sent Authorization: Bearer tnk_live_abcdef123456')
  const reason = reasonOf(leaky, 400, 'did not answer')
  expect(reason).toContain('ECONNREFUSED')
  expect(reason).not.toContain('tnk_live_abcdef123456')
  expect(reason).toContain('Bearer <redacted>')
})
