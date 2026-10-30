import { expect, test } from 'claude-code/testing'

import { classify, errorLineOf, headlineOf, keyOf, projectOf, redact, viewOf } from '../hooks/core/builds'
import { confidenceOf, estimate, wpct } from '../hooks/core/eta'

import type { Build, BuildRun } from '../types'

const T0 = 1_800_000_000_000
const SEC = 1_000

const runs = (...each: readonly number[]): BuildRun[] => each.map((s, i) => ({ at: T0 + i * 1000, ms: s * SEC }))

const build = (over: Partial<Build>): Build => ({
  id: 'b1',
  key: 'k',
  tool: 'vite',
  target: 'npm run build',
  project: 'web-app',
  state: 'running',
  startedAt: T0,
  runs: [],
  ...over,
})

test('a build command is told from an ordinary one', async () => {
  expect(classify('npm run build')?.tool).toBe('npm')
  expect(classify('npx vite build --mode=production')?.tool).toBe('vite')
  expect(classify('cargo build --release')?.tool).toBe('cargo')
  expect(classify('docker buildx build .')?.tool).toBe('docker')

  // Not builds, and the bar must not claim them.
  expect(classify('ls -la')).toBe(null)
  expect(classify('git status')).toBe(null)
  expect(classify('')).toBe(null)
})

test('a cold build is filed apart from a warm one', async () => {
  const warm = classify('docker build .')
  const cold = classify('docker build --no-cache .')
  expect(warm?.isCold).toBe(false)
  expect(cold?.isCold).toBe(true)

  // Same command, same place, different history, because the times differ.
  expect(keyOf('/src/app', 'docker build .', false)).toBe(keyOf('/src/app', 'docker build .', false))
  expect(keyOf('/src/app', 'docker build .', true)).not.toBe(keyOf('/src/app', 'docker build .', false))
  expect(keyOf('/src/other', 'docker build .', false)).not.toBe(keyOf('/src/app', 'docker build .', false))
})

test('the project is the folder it ran in, on either kind of path', async () => {
  expect(projectOf('C:\\src\\projects\\web-app')).toBe('web-app')
  expect(projectOf('/home/builds/projects/game/')).toBe('game')
})

test('a failure shows its first real error line, with secrets taken out', async () => {
  const output = [
    '',
    '> web-app@2.4.1 build',
    'src/lib/cart.ts(42,9): error TS2345: Argument of type string',
    'src/lib/other.ts(9,1): error TS2322: second one',
  ].join('\n')
  expect(errorLineOf(output)).toBe('src/lib/cart.ts(42,9): error TS2345: Argument of type string')

  expect(redact('fatal: could not read Bearer ghp_abcdefghijklmnop')).toBe('fatal: could not read Bearer <redacted>')
  expect(redact('token=github_pat_11ABCDEF')).toBe('token=github_pat_<redacted>')
})

test('with no history there is no estimate, and the bar says so', async () => {
  const est = estimate([], 30 * SEC)
  expect(est.stage).toBe('unknown')
  expect(est.progress).toBe(null)
  expect(est.remainingMs).toBe(null)

  const view = viewOf(build({ runs: [] }), T0 + 30 * SEC)
  expect(view.eta).toBe('no estimate yet')
})

test('a recent run counts for more than an old one', async () => {
  // Nine slow runs, then one fast: the median leans towards the recent.
  const mixed = runs(100, 100, 100, 100, 100, 100, 100, 100, 100, 10)
  const p50 = wpct(mixed, 0.5)
  expect(p50 !== null && p50 <= 100 * SEC).toBe(true)

  expect(wpct([], 0.5)).toBe(null)
})

test('a steady history is trusted more than a scattered one', async () => {
  expect(confidenceOf(runs(60, 61, 59, 60, 62))).toBe('high')
  expect(confidenceOf(runs(60, 90))).toBe('medium')
  expect(confidenceOf(runs(10, 300))).toBe('low')
})

test('a build inside its usual time counts down', async () => {
  const history = runs(60, 60, 60, 60, 60)
  const est = estimate(history, 30 * SEC)
  expect(est.stage).toBe('normal')
  expect(est.remainingMs).toBe(30 * SEC)
  expect(est.progress).toBe(0.5)
})

test('a build past its usual time stops counting down and says how far over', async () => {
  const history = runs(60, 60, 60, 60, 60)

  // Just over: the bar keeps moving but never arrives, and the claim changes.
  const over = estimate(history, 70 * SEC)
  expect(over.stage).toBe('over')
  expect(over.remainingMs).toBe(null)
  expect(over.overMs).toBe(10 * SEC)
  expect(over.progress !== null && over.progress > 0.95 && over.progress < 1).toBe(true)

  // Well over: re-based once, and marked uncertain.
  const wide = estimate(history, 100 * SEC)
  expect(wide.stage).toBe('wide')
  expect(wide.confidence).toBe('low')
  expect(wide.remainingMs !== null && wide.remainingMs > 0).toBe(true)

  // Twice over: the baseline no longer describes this run, so nothing is claimed.
  const lost = estimate(history, 200 * SEC)
  expect(lost.stage).toBe('unknown')
  expect(lost.remainingMs).toBe(null)
  expect(lost.progress).toBe(null)
})

test('a failure outranks everything else on the band', async () => {
  const list = [
    build({ id: 'a', state: 'running' }),
    build({ id: 'b', state: 'failed', endedAt: T0 }),
    build({ id: 'c', state: 'succeeded', endedAt: T0 }),
  ]
  expect(headlineOf(list, T0)?.id).toBe('b')

  // With nothing failed, a running build leads.
  expect(headlineOf([list[0] as Build, list[2] as Build], T0)?.id).toBe('a')

  // A build that finished a while ago steps aside entirely.
  expect(headlineOf([build({ id: 'c', state: 'succeeded', endedAt: T0 })], T0 + 120_000)).toBe(null)
})
