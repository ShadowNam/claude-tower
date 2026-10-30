import type { EngineInterface } from 'claude-code'

import { writePlan } from './state'

import type { Plan } from '../../types'

/**
 * The task list, read over the model's shoulder.
 *
 * The engine's own pinned list hangs under the message that wrote it and
 * scrolls away with it, so halfway through a long piece of work there is
 * nothing on screen saying what step it is on. This is the one thing the band
 * can show that is about what the session is *doing* rather than what it is
 * costing.
 *
 * Read passively, from the arguments of the call that writes the list. The
 * obvious alternative — registering a tool so the model reports its own
 * progress — costs tokens on every call, depends on the model remembering to
 * call it, and breaks the one thing this band promises: that every figure on
 * it is the engine's own rather than something a model said.
 *
 * Reading an MCP tool's **arguments** inside a `tool.call` hook is not
 * `$.mcp.call`, so none of this is refused in auto permission mode.
 */

/** The tools that carry a task list, whatever shape the host gives it. */
const LISTS: readonly string[] = ['TodoWrite', 'mcp__ccd_turn__update_plan']

export function isPlanTool(tool: string): boolean {
  return LISTS.includes(tool)
}

export type Step = { content: string; status: string }

/** The steps out of a call's arguments, in either host's spelling. */
function stepsOf(input: Readonly<Record<string, unknown>>): Step[] {
  const raw = input['todos'] ?? input['items']
  if (!Array.isArray(raw)) return []
  const out: Step[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const content = typeof r['content'] === 'string' ? r['content'] : ''
    const status = typeof r['status'] === 'string' ? r['status'] : ''
    if (content !== '') out.push({ content, status })
  }
  return out
}

/** How long a step's name may run before the row truncates it. */
const NAME_MAX = 48

/** The stored steps, folded into what the band draws. */
function viewOf(steps: readonly Step[]): Plan | null {
  if (steps.length === 0) return null
  const done = steps.filter(s => s.status === 'completed').length
  const name = steps.find(s => s.status === 'in_progress')?.content ?? ''
  return {
    steps,
    done,
    total: steps.length,
    now: name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name,
    finished: done >= steps.length,
  }
}

/**
 * A later update that names no steps, applied to the ones already held.
 *
 * This is why the band read `0/5` through a whole plan: a host advances a list
 * with `{ advance: true }` or `{ done: [2], start: 4 }` and sends no items, so
 * reading only the calls that carry a list meant reading only the first one.
 * The steps are kept so the moves can be applied to them.
 */
export function advanceOf(prev: Plan | null, input: Readonly<Record<string, unknown>>): Plan | null {
  if (prev === null || prev.steps.length === 0) return null
  const steps = prev.steps.map(s => ({ ...s }))
  const at = (n: unknown): number => (typeof n === 'number' ? n - 1 : -1)

  let moved = false

  if (input['advance'] === true) {
    const running = steps.findIndex(s => s.status === 'in_progress')
    if (running >= 0) {
      ;(steps[running] as Step).status = 'completed'
      moved = true
    }
    const next = steps.find(s => s.status === 'pending')
    if (next !== undefined) {
      next.status = 'in_progress'
      moved = true
    }
  }

  const done = input['done']
  if (Array.isArray(done)) {
    for (const n of done) {
      const i = at(n)
      if (i >= 0 && i < steps.length) {
        ;(steps[i] as Step).status = 'completed'
        moved = true
      }
    }
  }

  const start = at(input['start'])
  if (start >= 0 && start < steps.length) {
    ;(steps[start] as Step).status = 'in_progress'
    moved = true
  }

  return moved ? viewOf(steps) : null
}

/**
 * A call's arguments turned into what the band draws, or null when the call
 * carries no list — an `advance` or `done` update names no steps, and the
 * previous reading stays right.
 */
export function planOf(input: Readonly<Record<string, unknown>>): Plan | null {
  return viewOf(stepsOf(input))
}

/**
 * Records the list. Called from the mod's one tool.call hook in tools.ts,
 * before the call runs: the arguments are what carry the list, and whether the
 * call succeeds does not change what it said.
 */
export async function notePlan(
  $: EngineInterface,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!isPlanTool(tool)) return
  const listed = planOf(input)
  if (listed !== null) {
    await writePlan($, () => listed)
    return
  }
  // No list in this call: it is a move within the one already held.
  await writePlan($, prev => advanceOf(prev, input) ?? prev)
}
