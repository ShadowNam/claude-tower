import { expect, test } from 'claude-code/testing'

import { sweepStale } from '../hooks/core/builds'
import { buildOf } from '../hooks/core/marker'

import type { Build } from '../types'

const T0 = 1_800_000_000_000
const MIN = 60_000

test('a marker file is only trusted while its writer keeps breathing', async () => {
  const marker = {
    schema: 1,
    id: 'b1',
    project: 'web-app',
    target: 'vite build',
    state: 'running',
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    heartbeatSec: 5,
    progress: 0.62,
    step: { name: 'bundling client' },
    version: '2.4.1',
  }

  const live = buildOf(marker, '/src/web-app', T0 + 5_000)
  expect(live?.state).toBe('running')
  expect(live?.progress).toBe(0.62)
  expect(live?.step).toBe('bundling client')
  expect(live?.version).toBe('2.4.1')

  // Three heartbeats missed: the writer is gone, so the build is unknown and
  // not left running for ever.
  const gone = buildOf(marker, '/src/web-app', T0 + 60_000)
  expect(gone?.state).toBe('stale')
})

test('a marker that cannot be trusted is ignored outright', async () => {
  const base = { schema: 1, startedAt: new Date(T0).toISOString() }
  expect(buildOf({ ...base, schema: 2 }, '/x', T0)).toBe(null)
  expect(buildOf({ schema: 1 }, '/x', T0)).toBe(null)
  expect(buildOf('not an object', '/x', T0)).toBe(null)
  // Left behind by a run from yesterday.
  expect(buildOf(base, '/x', T0 + 25 * 60 * MIN)).toBe(null)
})

test('a watched source that goes quiet becomes unknown, a local build much later', async () => {
  const build = (over: Partial<Build>): Build => ({
    id: 'b',
    key: 'k',
    tool: 'vite',
    target: 'build',
    project: 'p',
    state: 'running',
    origin: 'session',
    startedAt: T0,
    lastSeenAt: T0,
    runs: [],
    ...over,
  })

  const staleMs = 10 * MIN
  // A CI run nobody has confirmed for a quarter of an hour.
  expect(sweepStale([build({ origin: 'ci' })], T0 + 15 * MIN, staleMs)[0]?.state).toBe('stale')
  // A local build at the same age is simply a long build.
  expect(sweepStale([build({ origin: 'session' })], T0 + 15 * MIN, staleMs)[0]?.state).toBe('running')
  // Two hours later it is not.
  expect(sweepStale([build({ origin: 'session' })], T0 + 130 * MIN, staleMs)[0]?.state).toBe('stale')
})
