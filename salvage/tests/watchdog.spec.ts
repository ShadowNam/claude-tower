import { expect, test } from 'claude-code/testing'

import { EMPTY_WATCHDOG, isProtected, isTransient, MAX_RESUMES, mayResume, noteResume } from '../hooks/core/watchdog'

const T0 = 1_800_000_000_000
const MIN = 60_000
const LOST = 'API Error: Connection lost mid-response.'

test('only the machinery failing is worth another go', async () => {
  // The failure that accounts for most of Tank's errored tasks.
  expect(isTransient(LOST)).toBe(true)
  expect(isTransient('socket hang up')).toBe(true)
  expect(isTransient('upstream returned 503')).toBe(true)

  // A task that failed on its own merits is left alone.
  expect(isTransient('tests failed: 3 assertions')).toBe(false)
  expect(isTransient('TypeError: undefined is not a function')).toBe(false)
  expect(isTransient('')).toBe(false)
})

test('a watchdog has no business on a protected branch', async () => {
  expect(isProtected('main')).toBe(true)
  expect(isProtected('master')).toBe(true)
  expect(isProtected('production')).toBe(true)
  expect(isProtected('release/1.2')).toBe(true)
  expect(isProtected('tank/queue-2c028b7e')).toBe(false)
  expect(isProtected(undefined)).toBe(false)
})

test('alert mode never resumes anything, whatever the failure', async () => {
  expect(mayResume(EMPTY_WATCHDOG, 'alert', 't1', 'tank/queue-1', LOST, T0).ok).toBe(false)
  expect(mayResume(EMPTY_WATCHDOG, 'off', 't1', 'tank/queue-1', LOST, T0).ok).toBe(false)
  expect(mayResume(EMPTY_WATCHDOG, 'resume', 't1', 'tank/queue-1', LOST, T0).ok).toBe(true)
})

test('a task is resumed twice and then left alone for good', async () => {
  let state = EMPTY_WATCHDOG
  expect(mayResume(state, 'resume', 't1', 'tank/q', LOST, T0).ok).toBe(true)

  state = noteResume(state, 't1', T0)
  // Not again straight away.
  expect(mayResume(state, 'resume', 't1', 'tank/q', LOST, T0 + MIN).ok).toBe(false)
  // After the gap, once more.
  expect(mayResume(state, 'resume', 't1', 'tank/q', LOST, T0 + 10 * MIN).ok).toBe(true)

  state = noteResume(state, 't1', T0 + 10 * MIN)
  expect(state.tasks['t1']?.count).toBe(MAX_RESUMES)
  // And never again, however long passes.
  expect(mayResume(state, 'resume', 't1', 'tank/q', LOST, T0 + 10 * 60 * MIN).ok).toBe(false)
})

test('an hour of resumes across everything is the ceiling', async () => {
  let state = EMPTY_WATCHDOG
  for (let i = 0; i < 5; i++) state = noteResume(state, `t${i}`, T0 + i * MIN)

  // A sixth task, perfectly eligible on its own terms, still waits.
  expect(mayResume(state, 'resume', 't9', 'tank/q', LOST, T0 + 6 * MIN).ok).toBe(false)
  // An hour on, the earlier ones no longer count.
  expect(mayResume(state, 'resume', 't9', 'tank/q', LOST, T0 + 70 * MIN).ok).toBe(true)
})

test('every refusal says why, so the panel can repeat it', async () => {
  expect(mayResume(EMPTY_WATCHDOG, 'resume', 't', 'main', LOST, T0).why).toBe('main is protected')
  expect(mayResume(EMPTY_WATCHDOG, 'resume', 't', 'tank/q', 'tests failed', T0).why).toBe(
    'the failure was not a transient one',
  )
  expect(mayResume(EMPTY_WATCHDOG, 'alert', 't', 'tank/q', LOST, T0).why).toBe('the watchdog only alerts')
})
