import { expect, test } from 'claude-code/testing'

import { project, projectWithin, trim } from '../hooks/core/burn'
import { priceOf, rewarmCost } from '../hooks/core/prices'
import { cacheView, fold } from '../hooks/core/usage'

import type { Sample, Usage } from '../types'

const T0 = 1_800_000_000_000
const MIN = 60_000

const EMPTY: Usage = {
  windows: [],
  cache: null,
  ledger: { usd: null, tokens: 0, window: 0 },
  samples: {},
}

/** Readings every three minutes, rising by ten points each time. */
const trail = (points: readonly number[]): Sample[] =>
  points.map((percent, i) => ({ at: T0 + i * 3 * MIN, percent }))

test('a rate needs enough readings over enough time', async () => {
  const now = T0 + 6 * MIN

  // Two readings say nothing, however far apart.
  expect(project(trail([10, 30]), now, 30)).toBe(null)

  // Nor do three taken inside a couple of minutes.
  const hurried: Sample[] = [
    { at: now - 60_000, percent: 10 },
    { at: now - 30_000, percent: 20 },
    { at: now, percent: 30 },
  ]
  expect(project(hurried, now, 30)).toBe(null)
})

test('a window being spent steadily is projected forward', async () => {
  const now = T0 + 6 * MIN
  // 30% spent over 6 minutes leaves 70%, so about 21 minutes more.
  const at = project(trail([10, 20, 30]), now, 30)
  expect(at).toBe(now + 21 * MIN)
})

test('a window that is not being spent has no projection', async () => {
  const now = T0 + 6 * MIN
  // Flat, then a rolling window that just rolled and reads lower than before.
  expect(project(trail([30, 30, 30]), now, 30)).toBe(null)
  expect(project(trail([40, 35, 30]), now, 30)).toBe(null)
})

test('a limit that resets before it runs out is not news', async () => {
  const now = T0 + 6 * MIN
  const samples = trail([10, 20, 30])

  // It would run out in 21 minutes, but the window resets in 10.
  const soon = new Date(now + 10 * MIN).toISOString()
  expect(projectWithin(samples, now, 30, soon)).toBe(null)

  // Reset an hour out, and running out first is worth saying.
  const later = new Date(now + 60 * MIN).toISOString()
  expect(projectWithin(samples, now, 30, later)).toBe(now + 21 * MIN)
})

test('readings older than the trailing window are dropped', async () => {
  const stale: Sample[] = [{ at: T0, percent: 1 }]
  const kept = trim(stale, { at: T0 + 31 * MIN, percent: 50 })
  expect(kept.length).toBe(1)
  expect(kept[0]?.percent).toBe(50)
})

test('the fold orders the slow window first and records a reading', async () => {
  const next = fold(
    EMPTY,
    {
      changed: ['rateLimits', 'context', 'cost'],
      rateLimits: [
        { kind: 'five_hour', percentUsed: 15 },
        { kind: 'seven_day', percentUsed: 31 },
      ],
      context: { tokens: 322_000, window: 1_000_000 },
      cost: { usd: 2.14 },
    },
    T0,
  )

  expect(next.windows.map(w => w.kind).join(',')).toBe('seven_day,five_hour')
  expect(next.ledger.usd).toBe(2.14)
  expect(next.ledger.tokens).toBe(322_000)
  expect(next.samples['seven_day']?.length).toBe(1)
  // One reading is never enough to project from.
  expect(next.windows[0]?.emptyAt).toBe(null)
})

test('the ledger keeps its last figure when a measurement leaves it out', async () => {
  const seeded = fold(
    EMPTY,
    { changed: ['cost'], rateLimits: [], context: { tokens: 0, window: 0 }, cost: { usd: 9.5 } },
    T0,
  )
  const later = fold(seeded, { changed: ['context'], rateLimits: [], context: { tokens: 1, window: 2 } }, T0)
  expect(later.ledger.usd).toBe(9.5)
})

test('the cache goes cold on the hour', async () => {
  const facts = { lastAt: T0, tokens: 322_000, window: 1_000_000, model: 'claude-opus-5' }

  expect(cacheView(facts, T0 + 59 * MIN)?.mode).toBe('warm')
  expect(cacheView(facts, T0 + 61 * MIN)?.mode).toBe('cold')

  // Nothing measured yet is nothing to draw.
  expect(cacheView({ ...facts, tokens: 0 }, T0)).toBe(null)
  expect(cacheView(null, T0)).toBe(null)
})

test('a model the price table does not name is priced as unknown', async () => {
  expect(priceOf('claude-opus-5-5')?.[3]).toBe(8)
  expect(priceOf('some-future-model')).toBe(null)
  expect(rewarmCost('some-future-model', 100_000)).toBe(null)

  // 100k tokens written again at $8 per million.
  expect(rewarmCost('claude-opus-5-5', 100_000)).toBe(0.8)
})
