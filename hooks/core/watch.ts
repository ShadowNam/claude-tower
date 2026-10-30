import type { EngineInterface } from 'claude-code'

import { sweepStale } from './builds'
import type { Feature, Options } from './kinds'
import { MARKER_MS, pollMarker, SNIPPET } from './marker'
import { writeBuilds } from './state'

/** A watched source that has said nothing for this long is no longer known. */
const STALE_MS = 10 * 60_000

/**
 * The background watcher: the marker file a build script writes. It runs on a
 * timer rather than on anything the model does, so a build is watched whether
 * or not the session is busy — and it costs no token, because it never goes
 * through the model.
 */
export async function startWatch($: EngineInterface, options: Options): Promise<void> {
  if (options.buildBar !== true) return

  try {
    const cwd = String(await $.session.cwd())

    await $.command.register({
      name: 'tower-hook',
      description: 'Print the snippet that lets a build script report its own progress.',
    })

    $.clock.every(MARKER_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await pollMarker($, cwd, now)
        await writeBuilds($, prev => sweepStale(prev, now, STALE_MS))
      })()
    })
  } catch {
    // No working directory, no watcher: the rest of the mod is unaffected.
  }
}

/** `/tower-hook`: the emitter a build script needs to report its own progress. */
export const registerWatch: Feature = (on, options) => {
  if (options.buildBar !== true) return

  on('command.run', { command: 'tower-hook' }, async $ => {
    const cwd = String(await $.session.cwd())
    return {
      text: [
        'To show progress for a build Tower cannot see — one started outside this',
        'session, or a script of your own — have it write .buildstatus.json in',
        `${cwd}`,
        '',
        'There is no library and nothing to install: any language that can write a',
        'JSON file can do this. These are the only fields that matter.',
        '',
        '  schema       1',
        '  startedAt    ISO time the build began',
        '  updatedAt    ISO time of this write — stop writing and the bar goes unknown',
        '  heartbeatSec how often you promise to write; 3 missed and it is dropped',
        '  state        running | succeeded | failed | cancelled',
        '  progress     0 to 1, if you know it; leave it out if you do not',
        '  step         { name: "bundling" }',
        '  project      what to call it; version, target  what is being built',
        '  error        the first error line, on a failure',
        '',
        'In Node, where a build script usually already is:',
        '',
        SNIPPET,
        '',
        'Call status() as the build moves, and once more when it ends. Tower reads',
        'the file every two seconds and times the build itself, so after a few runs',
        'it can tell you how long this one has left.',
      ].join('\n'),
    }
  })
}
