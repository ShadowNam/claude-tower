import type { Register } from 'claude-code'

import { registerAgents } from './core/agents'
import { registerBoot } from './core/boot'
import { registerDiag } from './core/diag'
import { registerNotify } from './core/notify'
import { registerTank } from './core/tank'
import { registerTools } from './core/tools'
import { registerTurns } from './core/turns'
import { registerUsage } from './core/usage'
import { registerWatch } from './core/watch'
import { registerBand } from './ui/band'
import { registerAgentsPane } from './ui/pane-agents'
import { registerTankPane } from './ui/pane-tank'

/**
 * Tower's entry module. `hooks.json` names a single module path, so each
 * feature is a function wired here rather than a module of its own.
 *
 * Collectors go first and drawings last: a collector only writes state, a
 * drawing only reads it, and nothing in a render does work. Where two
 * features want the same event, one module owns it and fans out — boot.ts for
 * session.start, turns.ts for turn.step and turn.complete.
 */
export const register: Register = (on, options) => {
  registerBoot(on, options)
  registerTurns(on, options)
  registerTools(on, options)
  registerDiag(on, options)
  registerUsage(on, options)
  registerAgents(on, options)
  registerWatch(on, options)
  registerTank(on, options)
  registerNotify(on, options)
  registerBand(on, options)
  registerAgentsPane(on, options)
  registerTankPane(on, options)
}
