import type { EngineInterface } from 'claude-code'

import type { Feature } from './kinds'
import { shortModel, windowOf } from './models'
import { costOf } from './prices'
import type { ModelUsage } from './prices'
import { readAgents, readPanel, writeAgents, writePanel } from './state'

import type { AgentRun } from '../../types'

/** The main session's row. Not a subagent, but the biggest spender in most runs. */
export const MAIN = 'main'
/** The pane's id, which is also the requestId its render matches on. */
export const PANE = 'tower-agents'
/** Rows kept before the oldest are dropped. */
const MAX_AGENTS = 200
/** Distinct files remembered per agent. */
const MAX_TOUCHED = 50
/** A running agent with no model request for this long is probably wedged. */
export const STUCK_MS = 120_000
/** How much of a command or path a row will show. */
const DETAIL = 60

/**
 * Identity: a spawn records the engine's `agentId`, and every later event for
 * that loop carries the same id. That is how a tool call, a model request and
 * a completion all find their row without anything being threaded through the
 * prompt. The approach is savvy-progress's (MIT); see NOTICE.
 *
 * The main session is tracked as a row of its own under `MAIN`, because it is
 * usually the largest single cost in a run and leaving it out makes every
 * total wrong.
 */
function blank(id: string, now: number): AgentRun {
  return {
    id,
    type: MAIN,
    description: 'this session',
    model: '',
    status: 'running',
    startedAt: now,
    contextTokens: 0,
    contextMax: 0,
    isWindowKnown: true,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    steps: 0,
    lastStepAt: now,
    toolErrors: 0,
    touched: [],
  }
}

/** Seeds the main row so the panel has something true to say from the start. */
export async function startAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const model = await $.session.model()
  await writeAgents($, prev =>
    prev.some(a => a.id === MAIN) ? prev : [{ ...blank(MAIN, now), model: model ?? '' }, ...prev],
  )
  await $.command.register({
    name: 'tower-agents',
    description: 'Open or close the agents panel.',
  })
}

/** A row of the panel: a run and how deep in the spawn tree it sits. */
export type Row = { run: AgentRun; depth: number }

/** How deep the tree is drawn before it stops indenting. */
const MAX_DEPTH = 6

/**
 * The runs as a tree, parents before their children. `agent.spawn` carries the
 * loop it happened in, so nesting costs nothing to track and says a great deal
 * about where a run's time actually went.
 */
export function tree(list: readonly AgentRun[]): Row[] {
  const children = new Map<string, AgentRun[]>()
  for (const a of list) {
    const parent = a.id === MAIN ? '' : (a.parentId ?? MAIN)
    const kin = children.get(parent) ?? []
    kin.push(a)
    children.set(parent, kin)
  }

  const out: Row[] = []
  const walk = (parent: string, depth: number): void => {
    for (const run of children.get(parent) ?? []) {
      out.push({ run, depth })
      if (depth < MAX_DEPTH) walk(run.agentId ?? run.id, depth + 1)
    }
  }
  walk('', 0)

  // A run whose parent was never recorded still belongs on the panel.
  const placed = new Set(out.map(r => r.run.id))
  for (const run of list) if (!placed.has(run.id)) out.push({ run, depth: 1 })
  return out
}

export type Totals = {
  running: number
  done: number
  failed: number
  /** Null when any run used a model the price table does not name. */
  costUsd: number | null
  input: number
  output: number
  cache: number
  /** Clock time the subagents spanned, and the time they spent between them. */
  wallMs: number
  agentMs: number
}

/**
 * The roll-up. Wall time and summed agent time are both shown because their
 * ratio is the only thing that says whether a fan-out actually ran in
 * parallel, and that is usually the question being asked.
 */
export function totalsOf(list: readonly AgentRun[], now: number): Totals {
  const subs = list.filter(a => a.id !== MAIN)
  let costUsd: number | null = 0
  let input = 0
  let output = 0
  let cache = 0
  let first = Number.POSITIVE_INFINITY
  let last = 0
  let agentMs = 0

  for (const a of list) {
    costUsd = a.costUsd === null || costUsd === null ? null : costUsd + a.costUsd
    input += a.input
    output += a.output
    cache += a.cacheRead + a.cacheWrite
  }
  for (const a of subs) {
    const end = a.endedAt ?? now
    first = Math.min(first, a.startedAt)
    last = Math.max(last, end)
    agentMs += Math.max(0, end - a.startedAt)
  }

  return {
    running: subs.filter(a => a.status === 'running').length,
    done: subs.filter(a => a.status === 'done').length,
    failed: subs.filter(a => a.status === 'failed').length,
    costUsd,
    input,
    output,
    cache,
    wallMs: subs.length === 0 ? 0 : Math.max(0, last - first),
    agentMs,
  }
}

/** A new subagent loop, with the parent it was spawned in. */
export async function noteSpawn(
  $: EngineInterface,
  id: string,
  agentId: string | undefined,
  parentId: string | undefined,
  type: string,
  description: string,
  model: string,
): Promise<void> {
  const now = await $.clock.now()
  const win = windowOf(model)
  const run: AgentRun = {
    ...blank(id, now),
    agentId,
    parentId: parentId ?? MAIN,
    type,
    description,
    model,
    contextMax: win.tokens,
    isWindowKnown: win.isKnown,
  }
  await writeAgents($, prev => [...prev.filter(a => a.id !== id), run].slice(-MAX_AGENTS))
}

/** One model request: what it cost, how full the context is, when it happened. */
export async function noteStep(
  $: EngineInterface,
  agentId: string | undefined,
  model: string,
  effort: string | undefined,
  usage: ModelUsage | null,
): Promise<void> {
  if (usage === null) return
  const now = await $.clock.now()
  const id = agentId ?? MAIN
  const step = costOf(model, usage)
  const win = windowOf(model)

  await writeAgents($, prev =>
    prev.map(a => {
      if (a.id !== id && a.agentId !== id) return a
      return {
        ...a,
        model: model === '' ? a.model : model,
        effort: effort ?? a.effort,
        status: 'running',
        endedAt: undefined,
        // What the next request re-sends: this request's whole prompt plus
        // what it produced. Replaced each step, never accumulated.
        contextTokens:
          usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
        // The main row keeps 0 and the panel shows the session's real window.
        contextMax: a.id === MAIN ? 0 : win.tokens,
        isWindowKnown: a.id === MAIN ? true : win.isKnown,
        input: a.input + usage.input_tokens,
        output: a.output + usage.output_tokens,
        cacheRead: a.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: a.cacheWrite + usage.cache_creation_input_tokens,
        costUsd: step === null || a.costUsd === null ? null : a.costUsd + step,
        steps: a.steps + 1,
        lastStepAt: now,
      }
    }),
  )
}

/** The loop ended. A refusal, an abort and an error are each kept as the reason. */
export async function noteComplete(
  $: EngineInterface,
  agentId: string | undefined,
  reason: string,
): Promise<void> {
  const now = await $.clock.now()
  const id = agentId ?? MAIN
  // The main session finishes a turn and carries on; only a subagent ends.
  if (agentId === undefined) return
  await writeAgents($, prev =>
    prev.map(a =>
      a.id === id || a.agentId === id
        ? {
            ...a,
            status: reason === 'answer' ? 'done' : 'failed',
            reason: reason === 'answer' ? undefined : reason,
            endedAt: now,
            tool: undefined,
            toolDetail: undefined,
          }
        : a,
    ),
  )
}

/** What a tool call is working on, in a few words. */
export function detailOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const pick = (key: string): string => {
    const v = input[key]
    return typeof v === 'string' ? v : ''
  }
  const raw =
    tool === 'Bash'
      ? pick('command')
      : tool === 'Agent'
        ? pick('description')
        : tool === 'Glob' || tool === 'Grep'
          ? pick('pattern')
          : pick('file_path') || pick('path') || pick('url')
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > DETAIL ? `${one.slice(0, DETAIL - 1)}…` : one
}

/** A file a row has touched, kept distinct and capped. */
function withFile(touched: readonly string[], tool: string, detail: string): readonly string[] {
  if (detail === '' || !/^(Read|Edit|Write|NotebookEdit)$/.test(tool)) return touched
  if (touched.includes(detail)) return touched
  return [...touched, detail].slice(-MAX_TOUCHED)
}

export async function noteToolStart(
  $: EngineInterface,
  agentId: string | undefined,
  tool: string,
  detail: string,
): Promise<void> {
  const id = agentId ?? MAIN
  await writeAgents($, prev =>
    prev.map(a =>
      (a.id === id || a.agentId === id) && a.status === 'running'
        ? { ...a, tool, toolDetail: detail, touched: withFile(a.touched, tool, detail) }
        : a,
    ),
  )
}

export async function noteToolEnd($: EngineInterface, agentId: string | undefined, isError: boolean): Promise<void> {
  const id = agentId ?? MAIN
  await writeAgents($, prev =>
    prev.map(a =>
      a.id === id || a.agentId === id
        ? { ...a, tool: undefined, toolDetail: undefined, toolErrors: a.toolErrors + (isError ? 1 : 0) }
        : a,
    ),
  )
}

/** A short label for a row: `opus · high`. */
export function runModel(a: AgentRun): string {
  const m = a.model === '' ? 'unknown' : shortModel(a.model)
  return a.effort === undefined ? m : `${m} · ${a.effort}`
}

/**
 * The spawn and tool-call hooks. Model requests and completions arrive through
 * turns.ts, which owns those two events for the whole mod.
 */
export const registerAgents: Feature = (on, options) => {
  if (options.agentsPanel !== true) return

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    await noteSpawn(
      $,
      started.agentId ?? e.tool_use_id,
      started.agentId,
      e.parentAgentId,
      e.subagentType,
      e.description,
      started.model ?? '',
    )
    // The panel shows itself once, the first time there is anything in it.
    // A pane opened unasked needs room, and may not be placed; the band's
    // chip is what covers that case, so the result is not worth waiting on.
    const panel = await readPanel($)
    if (!panel.autoOpened) {
      await writePanel($, prev => ({ ...prev, autoOpened: true }))
      void $.ui.open({ id: PANE, title: 'Agents' })
    }
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tower-agents' }, async $ => {
    const list = await readAgents($)
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'Agents panel closed.' }
    }
    const placed = await $.ui.open({ id: PANE, title: 'Agents' })
    if (placed.isPlaced === false) {
      return { text: `No room for the panel at this width. ${list.length} agents tracked; the band has the summary.` }
    }
    return { text: '' }
  })
}
