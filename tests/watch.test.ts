import { expect, test } from 'claude-code/testing'

import { keyOf, runsKey, sweepStale } from '../hooks/core/builds'
import { changeOf, fold as foldEdit, hunkOf, isWriter } from '../hooks/core/edits'
import { branchOf, gitDirOf, isProtected } from '../hooks/core/git'
import { buildOf } from '../hooks/core/marker'
import { effortOf, faultWord } from '../hooks/core/shape'

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

test('an edit is counted by what it replaced, a write by what it wrote', async () => {
  // Edit: the lines going out and the lines coming in are both known.
  expect(changeOf('Edit', { file_path: '/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' }))
    .toEqual({ path: '/a.ts', added: 3, removed: 2 })

  // Write: the whole file is new, and nothing says what was there before.
  expect(changeOf('Write', { file_path: '/b.ts', content: 'a\nb\nc' }))
    .toEqual({ path: '/b.ts', added: 3, removed: 0 })

  // A call that changes no file on disk is not an edit.
  expect(changeOf('Bash', { command: 'ls' })).toBe(null)
  expect(changeOf('Edit', { old_string: 'x', new_string: 'y' })).toBe(null)
  expect(isWriter('Edit')).toBe(true)
  expect(isWriter('Read')).toBe(false)
})

test('the same file edited twice is still one file', async () => {
  let edits = { files: [] as readonly string[], added: 0, removed: 0 }
  edits = foldEdit(edits, { path: '/a.ts', added: 3, removed: 1 })
  edits = foldEdit(edits, { path: '/a.ts', added: 2, removed: 0 })
  edits = foldEdit(edits, { path: '/b.ts', added: 5, removed: 5 })

  expect(edits.files.length).toBe(2)
  expect(edits.added).toBe(10)
  expect(edits.removed).toBe(6)
})

test('only the faults a person can act on get a row', async () => {
  expect(faultWord('rate_limit')).toBe('rate limited')
  expect(faultWord('overloaded')).toBe('overloaded')
  expect(faultWord('billing_error')).toBe('billing')
  // An invalid request is the caller's bug, not the session's state.
  expect(faultWord('invalid_request')).toBe(null)
  expect(faultWord('unknown')).toBe(null)
})

test('an effort is a level the engine named, or nothing', async () => {
  expect(effortOf('xhigh')).toBe('xhigh')
  expect(effortOf('HIGH')).toBe('high')
  // An integer budget is a number of its own, not a level.
  expect(effortOf(4096)).toBe('4096')
  // Anything else is not claimed.
  expect(effortOf('turbo')).toBe('')
  expect(effortOf(undefined)).toBe('')
  expect(effortOf(Number.NaN)).toBe('')
})

test('a branch is read from HEAD, and a detached head says so', async () => {
  expect(branchOf('ref: refs/heads/main\n')).toEqual({ name: 'main', isDetached: false })
  expect(branchOf('ref: refs/heads/feat/tower-band\n'))
    .toEqual({ name: 'feat/tower-band', isDetached: false })

  // A bare SHA is a detached head, which is worth saying in itself.
  expect(branchOf('9f1c2ab3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9'))
    .toEqual({ name: '9f1c2ab', isDetached: true })

  expect(branchOf('')).toBe(null)
  expect(branchOf('something else entirely')).toBe(null)
})

test('a worktree keeps its git directory somewhere else', async () => {
  // In a linked worktree `.git` is a file naming the real directory — which is
  // the common case for a session the app started for a task.
  expect(gitDirOf('/repo', 'gitdir: /repo/.git/worktrees/tower\n'))
    .toBe('/repo/.git/worktrees/tower')
  // An ordinary checkout has a directory, and reading it fails harmlessly.
  expect(gitDirOf('/repo', null)).toBe('/repo/.git')
  expect(gitDirOf('/repo', 'not a gitdir line')).toBe('/repo/.git')
})

test('a branch where a stray commit matters is marked', async () => {
  for (const name of ['main', 'master', 'production', 'prod', 'release/2.4', 'MAIN']) {
    expect(isProtected(name)).toBe(true)
  }
  for (const name of ['feat/x', 'fix', 'mainline', 'release-notes']) {
    expect(isProtected(name)).toBe(false)
  }
})

test('the last edit becomes a hunk the engine can colour', async () => {
  const hunk = hunkOf('/src/lib/cart.ts', 'const a = 1', 'const a = 2')
  expect(hunk.split('\n')).toEqual([
    '--- a/cart.ts',
    '+++ b/cart.ts',
    // The counts are not decoration: without them the engine refuses to read
    // this as a diff and draws it as plain code, saying so in the transcript.
    // The start lines are unknowable, so both are 1, as a fragment's are.
    '@@ -1,1 +1,1 @@',
    '-const a = 1',
    '+const a = 2',
  ])

  // The counts must describe the lines actually emitted. A hunk cut to the
  // display limit fails the same check for the opposite reason otherwise.
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const header = /@@ -1,(\d+) \+1,(\d+) @@/.exec(hunkOf('/a.ts', big, big))
  const body = hunkOf('/a.ts', big, big).split('\n')
  expect(Number(header?.[1])).toBe(body.filter(l => l.startsWith('-') && !l.startsWith('---')).length)
  expect(Number(header?.[2])).toBe(body.filter(l => l.startsWith('+') && !l.startsWith('+++')).length)

  // A Write has nothing before it, so the body is all additions. The `--- a/`
  // header carries hyphens of its own, so only the body is checked.
  const written = hunkOf('/src/new.ts', '', 'one\ntwo').split('\n').slice(3)
  expect(written).toEqual(['+one', '+two'])

  // A long edit is cut and says so, rather than filling the panel.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const cut = hunkOf('/a.ts', long, long)
  expect(cut).toContain('\\ truncated')
  expect(cut.split('\n').length).toBeLessThan(40)

  // Windows paths are paths too — and the separators have to survive being
  // written down, which is its own trap in a JavaScript string.
  expect(hunkOf('C:\\src\\app\\main.ts', 'a', 'b')).toContain('--- a/main.ts')
  expect(hunkOf('/home/me/src/main.ts', 'a', 'b')).toContain('--- a/main.ts')
})

test('the history is written where it is read from', async () => {
  // A reader and a writer that disagree about the key fail silently and for
  // ever: the history is written, nothing reads it, and the estimate never
  // arrives. Both sides go through one helper so they cannot drift.
  expect(runsKey('abc123')).toBe('build:abc123')
  expect(runsKey(keyOf('/src/app', 'npm run build', false)))
    .toBe(`build:${keyOf('/src/app', 'npm run build', false)}`)
})
