import type { EngineInterface } from 'claude-code'

import { projectOf } from './builds'
import { writeBuilds } from './state'

import type { Build, BuildState } from '../../types'

/**
 * GitHub Actions is the one source that reports real progress for free.
 *
 * The moment a job starts, GitHub publishes its whole `steps` array from the
 * workflow file, each with a status and exact timestamps. That gives a
 * denominator and a numerator with no cooperation from anyone, which nothing
 * running locally does.
 *
 * Polling is cheap because of ETags: a 304 does not count against the hourly
 * rate limit, so a run can be watched closely without spending anything.
 */

/** While a run is active. */
const FAST_MS = 10_000
/** When nothing is happening. */
const SLOW_MS = 120_000
/** A run older than this is not worth showing. */
const RECENT_MS = 30 * 60_000

export type Step = { name: string; status: string; conclusion: string | null }

/** `owner/name` from a git remote, or null when it is not a GitHub one. */
export function repoOf(remote: string | null): string | null {
  if (remote === null) return null
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (m === null) return null
  const owner = m[1]
  const name = m[2]
  return owner === undefined || name === undefined ? null : `${owner}/${name}`
}

/** GitHub's own words for where a run is, in ours. */
export function stateOf(status: string, conclusion: string | null): BuildState {
  if (status !== 'completed') return 'running'
  if (conclusion === 'success') return 'succeeded'
  if (conclusion === 'cancelled' || conclusion === 'skipped') return 'cancelled'
  return 'failed'
}

/**
 * How far a job is, weighted by nothing but step counts.
 *
 * Steps can be added mid-run by composite actions, so the denominator is
 * recounted every poll rather than remembered. A step that was skipped took
 * no time and must not count as progress.
 */
export function progressOf(steps: readonly Step[]): { progress: number; step: string } | null {
  const real = steps.filter(s => s.conclusion !== 'skipped')
  if (real.length === 0) return null
  const done = real.filter(s => s.status === 'completed').length
  const current = real.find(s => s.status === 'in_progress')
  const progress = Math.max(0, Math.min(1, (done + (current === undefined ? 0 : 0.5)) / real.length))
  return { progress, step: current?.name ?? `${done}/${real.length} steps` }
}

/** The first failing step of a run, which is the only one worth naming. */
export function failingStepOf(steps: readonly Step[]): string | null {
  return steps.find(s => s.conclusion === 'failure')?.name ?? null
}

type Cached = { etag: string | null; at: number }
const cache = new Map<string, Cached>()

async function get(
  $: EngineInterface,
  url: string,
  token: string,
): Promise<{ body: unknown; notModified: boolean } | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  }
  const known = cache.get(url)
  if (known?.etag != null) headers['If-None-Match'] = known.etag

  try {
    const res = await $.http.fetch(url, { headers })
    if (res.status === 304) return { body: null, notModified: true }
    if (!res.ok) return null
    const etag = res.headers['etag'] ?? res.headers['ETag'] ?? null
    cache.set(url, { etag, at: Date.now() })
    return { body: JSON.parse(res.text) as unknown, notModified: false }
  } catch {
    // A network that will not answer costs a refresh, not the session.
    return null
  }
}

/**
 * One poll: the newest workflow run, and if it is recent, its jobs' steps.
 * Returns how long to wait before the next one.
 */
export async function pollCi($: EngineInterface, repo: string, token: string, now: number): Promise<number> {
  const runs = await get($, `https://api.github.com/repos/${repo}/actions/runs?per_page=1`, token)
  if (runs === null) return SLOW_MS
  if (runs.notModified) return FAST_MS

  const list = (runs.body as { workflow_runs?: unknown })?.workflow_runs
  const run = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined
  if (run === undefined) return SLOW_MS

  const id = String(run['id'] ?? '')
  const status = String(run['status'] ?? '')
  const conclusion = run['conclusion'] === null ? null : String(run['conclusion'] ?? '')
  const startedAt = Date.parse(String(run['run_started_at'] ?? run['created_at'] ?? ''))
  if (id === '' || Number.isNaN(startedAt)) return SLOW_MS

  const state = stateOf(status, conclusion)
  // A finished run from hours ago is history, not status.
  if (state !== 'running' && now - startedAt > RECENT_MS) return SLOW_MS

  let progress: number | undefined
  let step: string | undefined
  let errorLine: string | undefined

  const jobs = await get($, `https://api.github.com/repos/${repo}/actions/runs/${id}/jobs`, token)
  if (jobs !== null && !jobs.notModified) {
    const rows = (jobs.body as { jobs?: unknown })?.jobs
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    const steps = Array.isArray(first?.['steps'])
      ? (first['steps'] as Record<string, unknown>[]).map(s => ({
          name: String(s['name'] ?? ''),
          status: String(s['status'] ?? ''),
          conclusion: s['conclusion'] === null ? null : String(s['conclusion'] ?? ''),
        }))
      : []
    const where = progressOf(steps)
    if (where !== null) {
      progress = where.progress
      step = where.step
    }
    const failing = failingStepOf(steps)
    if (failing !== null) errorLine = `failed at step: ${failing}`
  }

  const build: Build = {
    id: `ci:${id}`,
    key: `ci:${repo}`,
    tool: 'github',
    target: String(run['name'] ?? 'workflow'),
    project: projectOf(repo),
    version: `#${String(run['run_number'] ?? '')}`,
    state,
    origin: 'ci',
    startedAt,
    endedAt: state === 'running' ? undefined : now,
    lastSeenAt: now,
    progress,
    step,
    errorLine,
    url: typeof run['html_url'] === 'string' ? run['html_url'] : undefined,
    runs: [],
  }

  await writeBuilds($, prev => [...prev.filter(b => b.id !== build.id), build].slice(-8))
  return state === 'running' ? FAST_MS : SLOW_MS
}

/** Where to poll, and whether we can: null when there is no repo or no token. */
export async function ciTargetOf($: EngineInterface, token: string): Promise<string | null> {
  if (token === '') return null
  try {
    const repo = await $.session.repo()
    return repo === null ? null : repoOf(repo.remote)
  } catch {
    return null
  }
}
