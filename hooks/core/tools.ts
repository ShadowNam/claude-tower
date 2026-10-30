import { detailOf, noteToolEnd, noteToolStart } from './agents'
import { isWorthTelling, noteBuildEnd, noteBuildStart } from './builds'
import { isWriter, noteEdit } from './edits'
import type { Feature } from './kinds'

/**
 * The mod's one tool.call hook. The agents panel wants every call, to show
 * what each loop is doing; the build bar wants the shell ones, to time them.
 * The engine takes a single unmatched registration per event, so both are
 * served from here.
 *
 * The call itself is passed straight through. Only the bookkeeping either
 * side of it belongs to the mod, and a failure in that bookkeeping must never
 * stop the call: a tool that works is worth more than a row that is right.
 */
export const registerTools: Feature = (on, options) => {
  const wantsAgents = options.agentsPanel === true
  const wantsBuilds = options.buildBar === true
  const wantsEdits = options.usageBand === true
  if (!wantsAgents && !wantsBuilds && !wantsEdits) return

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Readonly<Record<string, unknown>>

    if (wantsAgents) await noteToolStart($, e.agentId, tool, detailOf(tool, input))

    // Only a shell command can be a build, and only some of those are.
    let build: string | null = null
    if (wantsBuilds && (tool === 'Bash' || tool === 'PowerShell')) {
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : await $.session.cwd()
      build = await noteBuildStart($, e.tool_use_id, command, String(cwd))
    }

    // A call that throws still ended, and both rows have to be told.
    let result
    try {
      result = await next(e)
    } catch (err) {
      if (wantsAgents) await noteToolEnd($, e.agentId, true)
      if (build !== null) await noteBuildEnd($, build, true, '')
      throw err
    }

    const isError = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true

    if (wantsAgents) await noteToolEnd($, e.agentId, isError)
    // A call that failed changed nothing, so it is counted only once it has.
    if (wantsEdits && !isError && isWriter(tool)) await noteEdit($, tool, input)
    if (build !== null) {
      const out = typeof result === 'object' && result !== null ? (result as { result?: unknown }).result : undefined
      const done = await noteBuildEnd($, build, isError, typeof out === 'string' ? out : '')

      // noteBuildEnd files the run; the bar reads it from state.
      void done
    }

    return result
  }).catch(($, e, next) => next(e))
}
