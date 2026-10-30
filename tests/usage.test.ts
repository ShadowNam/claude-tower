import { expect, test } from 'claude-code/testing'

import { project, projectWithin, trim } from '../hooks/core/burn'
import { backgroundOf, heaviestOf, phaseOf, ttlOf } from '../hooks/core/engine'
import { isPlanTool, planOf } from '../hooks/core/plan'
import { fold as foldRate, median, rateOf } from '../hooks/core/rate'
import { priceOf, rewarmCost } from '../hooks/core/prices'
import { cacheView, compactionOf, fold, headroom } from '../hooks/core/usage'

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

test('the context figure measures against the window compaction fires on', async () => {
  // The engine's own typings: the compaction window "may be smaller than
  // `window`". Dividing by the larger one understates how close the session is
  // to being compacted, which is the only decision this figure drives.
  const measured = compactionOf(null, {
    changed: ['context'],
    rateLimits: [],
    context: {
      tokens: 120_000,
      window: 1_000_000,
      breakdown: {
        totalTokens: 120_000,
        rawMaxTokens: 200_000,
        autoCompactThreshold: 160_000,
        isAutoCompactEnabled: true,
      },
    },
  })

  expect(measured?.max).toBe(200_000)
  expect(headroom(measured)).toBe(40_000)
  // Against the model's window that reads 12%; against the real one, 60%.
  expect(Math.round((120_000 / 1_000_000) * 100)).toBe(12)
  expect(Math.round((measured!.used / measured!.max) * 100)).toBe(60)
})

test('nothing is claimed about compaction unless the engine said it', async () => {
  const base = { changed: ['context'], rateLimits: [], context: { tokens: 1, window: 1 } } as const

  // No breakdown in this measurement keeps whatever the last one said.
  const kept = { max: 200_000, used: 10, firesAt: 160_000, isEnabled: true }
  expect(compactionOf(kept, base)).toEqual(kept)
  expect(compactionOf(null, base)).toBe(null)

  // Auto-compaction off, or no threshold named, means no claim at all.
  expect(headroom({ max: 200_000, used: 10, firesAt: 160_000, isEnabled: false })).toBe(null)
  expect(headroom({ max: 200_000, used: 10, firesAt: null, isEnabled: true })).toBe(null)
  // Already past it is not a negative distance; it is nothing worth saying.
  expect(headroom({ max: 200_000, used: 170_000, firesAt: 160_000, isEnabled: true })).toBe(null)
})

test('a short turn says nothing about how fast the API is', async () => {
  // A two-token answer that took a second reads as 2 tok/s and means latency,
  // not throughput. Crying wolf on those is how a warning gets ignored.
  expect(rateOf(800, 2000)).toBe(null)
  expect(rateOf(10_000, 40)).toBe(null)
  expect(rateOf(Number.NaN, 500)).toBe(null)
  // A turn long enough to mean something gives its rate.
  expect(rateOf(10_000, 500)).toBe(50)
})

test('slow means slow for this session, and sustained', async () => {
  let r = null
  // Five ordinary turns at about 50 tok/s.
  for (const v of [50, 52, 48, 51, 49]) r = foldRate(r, v)
  expect(r?.isSlow).toBe(false)

  // One slow turn is noise, not news.
  r = foldRate(r, 20)
  expect(r?.slowRuns).toBe(1)
  expect(r?.isSlow).toBe(false)

  // Two in a row is worth saying.
  r = foldRate(r, 18)
  expect(r?.isSlow).toBe(true)

  // And one good turn clears it, rather than leaving a stale warning up.
  r = foldRate(r, 49)
  expect(r?.slowRuns).toBe(0)
  expect(r?.isSlow).toBe(false)
})

test('nothing is claimed about speed before there is a baseline', async () => {
  // Four turns is not enough to have a median worth comparing against, so even
  // a very slow one raises nothing.
  let r = null
  for (const v of [50, 50, 50, 2]) r = foldRate(r, v)
  expect(r?.isSlow).toBe(false)
  expect(median([])).toBe(null)
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
})

test('a plan is read from whichever host wrote it', async () => {
  const todos = { todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ] }
  expect(planOf(todos)).toEqual({ done: 1, total: 3, now: 'two', finished: false })

  // The desktop app spells the same thing differently.
  expect(planOf({ items: [{ content: 'a', status: 'completed' }] }))
    .toEqual({ done: 1, total: 1, now: '', finished: true })

  // An advance or done update names no steps, so the last reading stands.
  expect(planOf({ advance: true })).toBe(null)
  expect(planOf({ items: [] })).toBe(null)
  expect(isPlanTool('TodoWrite')).toBe(true)
  expect(isPlanTool('mcp__ccd_turn__update_plan')).toBe(true)
  expect(isPlanTool('Bash')).toBe(false)
})

test('the cache lifetime is the engine’s where it said it, an hour where it did not', async () => {
  const STARTED = 1_800_000_000_000
  const cache = { lastAt: STARTED, tokens: 1000, window: 200_000, model: 'claude-opus-5' }
  const idle = (mins: number) => STARTED + mins * 60_000

  // Ten minutes idle on a five-minute cache is cold. An assumed hour would
  // have claimed fifty minutes of warmth left, which is not slightly wrong.
  const short = cacheView(cache, idle(10), ttlOf('5m') ?? 0)
  expect(short?.mode).toBe('cold')

  // The same reading on an hour cache is warm, with the right countdown.
  const long = cacheView(cache, idle(10), ttlOf('1h') ?? 0)
  expect(long?.mode).toBe('warm')
  expect(long?.leftMin).toBe(50)

  // No lifetime given falls back to the hour rather than to zero.
  expect(cacheView(cache, idle(10))?.mode).toBe('warm')

  expect(ttlOf('5m')).toBe(300_000)
  expect(ttlOf('1h')).toBe(3_600_000)
  // Anything else is not guessed at.
  expect(ttlOf('30m')).toBe(null)
  expect(ttlOf(undefined)).toBe(null)
})

test('the heaviest thing named is one a person could switch off', async () => {
  const heavy = heaviestOf({
    mcpTools: [
      { name: 'mcp__a__x', serverName: 'dropbox', tokens: 9_000 },
      { name: 'mcp__a__y', serverName: 'dropbox', tokens: 9_000 },
      { name: 'mcp__b__z', serverName: 'tank', tokens: 4_000 },
    ],
    categories: [
      { name: 'Messages', tokens: 120_000, kind: 'used' },
      { name: 'Memory files', tokens: 12_000, kind: 'used' },
      { name: 'Free space', tokens: 60_000, kind: 'free' },
    ],
  })
  // Tools are summed per server, which is the thing you would actually turn off.
  expect(heavy).toEqual({ name: 'dropbox', tokens: 18_000 })

  // The conversation is the largest thing in every context and the one thing
  // nobody can act on, so it is never named.
  expect(heaviestOf({ categories: [{ name: 'Messages', tokens: 500_000, kind: 'used' }] })).toBe(null)
  expect(heaviestOf(null)).toBe(null)
  expect(heaviestOf({})).toBe(null)
})

test('what the turn is doing, in words a band can hold', async () => {
  expect(phaseOf('thinking')).toBe('thinking')
  expect(phaseOf('tool-use')).toBe('tool')
  expect(phaseOf('tool-input')).toBe('tool')
  expect(phaseOf('responding')).toBe('writing')
  expect(phaseOf('nonsense')).toBe(null)
})

test('background work is a snapshot, and says only what it saw', async () => {
  const bg = backgroundOf(
    [{ id: '1', type: 'shell', status: 'running', description: 'dev server' },
     { id: '2', type: 'workflow', status: 'running', description: 'review' }],
    [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'x' }],
    1_800_000_000_000,
  )
  expect(bg.count).toBe(2)
  expect(bg.kinds).toEqual(['shell', 'workflow'])
  expect(bg.scheduled).toBe(1)

  // Nothing in flight is not an empty list to draw; it is no chip at all.
  expect(backgroundOf([], [], 0).count).toBe(0)
  expect(backgroundOf(undefined, undefined, 0).scheduled).toBe(0)
})
