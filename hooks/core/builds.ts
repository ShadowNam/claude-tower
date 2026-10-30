import type { EngineInterface } from 'claude-code'

import { estimate, remember } from './eta'
import type { Estimate } from './eta'
import { redact, since } from './fmt'
import { writeBuilds } from './state'

import type { Build, BuildRun, BuildState } from '../../types'

/** Durations kept per build. Twenty is enough for a stable median. */
const MAX_RUNS = 20
/** Builds tracked at once before the oldest finished ones are dropped. */
const MAX_BUILDS = 8
/** Shorter than this and nobody wanted to know. */
const MIN_INTEREST_MS = 3_000
/** A finished build stays on the band this long, unless it failed. */
const LINGER_MS = 60_000
/** How much of a command a row will show. */
const TARGET = 70

/**
 * The build tools worth recognising, and what to call them. First match wins,
 * so the specific patterns sit above the package-manager catch-all.
 */
const TOOLS: readonly (readonly [RegExp, string])[] = [
  [/\bnext\s+build\b/, 'next'],
  [/\bvite\s+build\b/, 'vite'],
  [/\bturbo\s+(run|build)\b/, 'turbo'],
  [/\bwebpack\b/, 'webpack'],
  [/\bcargo\s+(build|test|check|clippy)\b/, 'cargo'],
  [/\bdocker\s+(build|buildx)\b/, 'docker'],
  [/\bdotnet\s+(build|publish|test)\b/, 'dotnet'],
  [/\bmsbuild\b/, 'msbuild'],
  [/\bgradlew?\b/, 'gradle'],
  [/\bmvn\b/, 'maven'],
  [/\btsc\b/, 'tsc'],
  [/\bmake\b/, 'make'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|check)\b/, 'npm'],
]

/** A command that throws the cache away takes a different time entirely. */
const COLD = /--no-cache\b|--force\b|\bclean\b|\bpurge\b|rm\s+-rf/

export type Classified = { tool: string; target: string; isCold: boolean }

/** What this command is building, or null when it is not a build at all. */
export function classify(command: string): Classified | null {
  const one = command.replace(/\s+/g, ' ').trim()
  if (one === '') return null
  const hit = TOOLS.find(([re]) => re.test(one))
  if (hit === undefined) return null
  return {
    tool: hit[1],
    target: one.length > TARGET ? `${one.slice(0, TARGET - 1)}…` : one,
    isCold: COLD.test(one),
  }
}

/**
 * A stable key for a build's history. Not a cryptographic hash and not
 * pretending to be one: FNV-1a over the three things that change how long a
 * build takes, which is all a lookup key has to tell apart.
 */
export function keyOf(cwd: string, target: string, isCold: boolean): string {
  const s = `${cwd}|${target}|${isCold ? 'cold' : 'warm'}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The one line worth showing from a failed build's output. */
export function errorLineOf(output: string): string {
  const lines = output.split(/\r?\n/).map(l => l.trim())
  const named = lines.find(l => l !== '' && /\berror\b|\bERROR\b|\bFAIL\b|\bfailed\b/.test(l))
  const line = named ?? lines.find(l => l !== '') ?? ''
  return redact(line).slice(0, 140)
}

/** The folder's own name, which is what people call the project. */
export function projectOf(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? cwd
}

function isRun(v: unknown): v is BuildRun {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as BuildRun).at === 'number' &&
    typeof (v as BuildRun).ms === 'number' &&
    (v as BuildRun).ms > 0
  )
}

/**
 * Where a build's history lives in the store.
 *
 * One helper because a reader and a writer that disagree about the key fail
 * silently and for ever: the history is written, nothing ever reads it, and
 * the estimate simply never arrives. That happened here once.
 */
export function runsKey(key: string): string {
  return `build:${key}`
}

/** Past durations for this build, across every session that has run it. */
async function loadRuns($: EngineInterface, key: string): Promise<BuildRun[]> {
  try {
    const raw = await $.store.get(runsKey(key))
    const list = Array.isArray(raw) ? raw : (raw as { runs?: unknown } | null)?.runs
    return Array.isArray(list) ? list.filter(isRun).slice(-MAX_RUNS) : []
  } catch {
    // A store that will not answer costs an estimate, not the build.
    return []
  }
}

/** The project's version, when a manifest in the working directory names one. */
async function versionOf($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const text = String(await $.fs.read(`${cwd}/package.json`, { as: 'text' }))
    const parsed: unknown = JSON.parse(text)
    const v = (parsed as { version?: unknown }).version
    return typeof v === 'string' ? v : undefined
  } catch {
    // No manifest, or not JSON: the row simply shows no version.
    return undefined
  }
}

/**
 * A build has started. Returns its id when one was recognised, so the tool
 * hook knows whether to record the end.
 */
export async function noteBuildStart(
  $: EngineInterface,
  id: string,
  command: string,
  cwd: string,
): Promise<string | null> {
  const what = classify(command)
  if (what === null) return null

  const now = await $.clock.now()
  const key = keyOf(cwd, what.target, what.isCold)
  const runs = await loadRuns($, key)
  const version = await versionOf($, cwd)

  const build: Build = {
    id,
    key,
    tool: what.tool,
    target: what.target,
    project: projectOf(cwd),
    version,
    state: 'running',
    origin: 'session',
    startedAt: now,
    lastSeenAt: now,
    runs,
  }

  await writeBuilds($, prev => [...prev.filter(b => b.id !== id), build].slice(-MAX_BUILDS))
  return id
}

/** A build has ended. A success is remembered; a failure is only reported. */
export async function noteBuildEnd(
  $: EngineInterface,
  id: string,
  isError: boolean,
  output: string,
): Promise<Build | null> {
  const now = await $.clock.now()
  let finished: Build | null = null

  await writeBuilds($, prev =>
    prev.map(b => {
      if (b.id !== id) return b
      const state: BuildState = isError ? 'failed' : 'succeeded'
      const next: Build = {
        ...b,
        state,
        endedAt: now,
        errorLine: isError ? errorLineOf(output) : undefined,
      }
      finished = next
      return next
    }),
  )

  // Only successes go into the history. A failure ends early and would drag
  // the baseline down, so the next build would be told it is running late.
  const done: Build | null = finished
  if (done === null || isError) return done
  await rememberRun($, done.key, now - done.startedAt, now)
  return done
}

/** Whether a finished build ran long enough that someone would want telling. */
export function isWorthTelling(build: Build, now: number): boolean {
  return (build.endedAt ?? now) - build.startedAt >= 60_000
}

/** What the band draws, worked out from state alone. */
export type BuildView = {
  build: Build
  estimate: Estimate
  /** `~1m 48s left`, `+31s over the usual 2m 41s`, `no estimate yet`. */
  eta: string
  elapsed: string
  /** `web-app 2.4.1`, or just the project when no version was found. */
  title: string
}

export function viewOf(build: Build, now: number): BuildView {
  const end = build.endedAt ?? now
  const elapsedMs = Math.max(0, end - build.startedAt)
  const est = estimate(build.runs, elapsedMs, build.progress ?? null)

  let eta = ''
  if (build.state !== 'running') {
    eta = ''
  } else if (est.stage === 'normal' && est.remainingMs !== null) {
    // Confidence is shown as precision: a loose estimate is rounded, not
    // dressed up to the second.
    const ms = est.confidence === 'high' ? est.remainingMs : Math.round(est.remainingMs / 10_000) * 10_000
    eta = `~${since(ms)} left`
  } else if (est.stage === 'over') {
    eta = `+${since(est.overMs)} over`
  } else if (est.stage === 'wide' && est.remainingMs !== null) {
    eta = `~${since(est.remainingMs)} more`
  } else if (est.baselineMs !== null) {
    eta = `over ${(est.overMs / est.baselineMs + 1).toFixed(1)}× the usual ${since(est.baselineMs)}`
  } else {
    eta = 'no estimate yet'
  }

  return {
    build,
    estimate: est,
    eta,
    elapsed: since(elapsedMs),
    title: build.version === undefined ? build.project : `${build.project} ${build.version}`,
  }
}

/**
 * Which build the band shows. A failure outranks everything: it is the only
 * state that needs a person. Among the rest, running beats finished, and a
 * finished build steps aside after a minute.
 */
export function headlineOf(builds: readonly Build[], now: number): Build | null {
  const score = (b: Build): number => {
    if (b.state === 'failed') return 1000
    if (b.state === 'running') return 600
    if (b.state === 'stale') return 100
    return now - (b.endedAt ?? 0) < LINGER_MS ? 200 : 0
  }
  let best: Build | null = null
  let bestScore = 0
  for (const b of builds) {
    const s = score(b)
    if (s > bestScore) {
      best = b
      bestScore = s
    }
  }
  return best
}

/**
 * A build that nothing has confirmed for a long time is not finished, it is
 * unknown. Saying so is the honest end state; quietly showing it as still
 * running, or as succeeded, is not.
 */
export function sweepStale(builds: readonly Build[], now: number, staleMs: number): readonly Build[] {
  return builds.map(b => {
    if (b.state !== 'running') return b
    // A build this session started ends when its tool call returns, so only a
    // hook that failed badly leaves one running: give it far longer before
    // calling it unknown. A watched source going quiet is the real case.
    const limit = b.origin === 'session' ? staleMs * 12 : staleMs
    return now - b.lastSeenAt > limit ? { ...b, state: 'stale' as const, endedAt: now } : b
  })
}

/** Builds still worth a chip beside the headline. */
export function othersOf(builds: readonly Build[], headline: Build | null, now: number): readonly Build[] {
  return builds.filter(
    b => b.id !== headline?.id && (b.state === 'running' || b.state === 'failed' || now - (b.endedAt ?? 0) < LINGER_MS),
  )
}

/**
 * Keeps one finished build's duration, so the estimator has something to work
 * from next time.
 *
 * Exported because the marker file's poll needs it too: that is the source a
 * person is actually told to wire up, and a source that never teaches the
 * estimator would say "no estimate yet" for ever.
 */
export async function rememberRun($: EngineInterface, key: string, ms: number, now: number): Promise<void> {
  if (!Number.isFinite(ms) || ms < MIN_INTEREST_MS) return
  try {
    const runs = remember(await loadRuns($, key), { at: now, ms }, MAX_RUNS)
    // The same key and shape loadRuns reads. Writing a different one would
    // store a history nothing ever looks at, which fails silently for ever.
    await $.store.set(runsKey(key), { runs })
  } catch {
    // A history that cannot be written costs an estimate, never a build.
  }
}
