import type { EngineInterface } from 'claude-code'

import { panelsOf, since } from './fmt'
import type { Feature, Options } from './kinds'
import { readDiag, writeDiag } from './state'

/** Must match the version in .claude-plugin/plugin.json. */
const VERSION = '1.0.4'

/**
 * Seeds what `/tower` reports. Called from the mod's one session.start hook:
 * the engine takes a single unmatched registration per event, so boot.ts owns
 * it and each feature is started from there.
 */
export async function startDiag($: EngineInterface, surface: string, options: Options): Promise<void> {
  const at = await $.clock.now()

  let engine = 'unknown'
  try {
    engine = (await $.session.version()).version
  } catch {
    // A build that will not say stays 'unknown'; it must not hold up the load.
  }

  await writeDiag($, prev => ({
    version: VERSION,
    engine,
    surface,
    loadedAt: at,
    reloads: (prev?.reloads ?? 0) + 1,
    panels: panelsOf(options),
    // A fresh load starts clean: last load's failures say nothing about this one.
    failures: [],
  }))

  await $.command.register({
    name: 'tower',
    description: 'Tower diagnostics: what loaded, what is switched on, and where it draws.',
  })
}

/**
 * Records the features that threw while starting. Called from boot.ts once the
 * fan-out is done, so `/tower` can name a missing panel's reason instead of
 * leaving the mod looking uninstalled.
 */
export async function noteFailures($: EngineInterface, failures: readonly string[]): Promise<void> {
  await writeDiag($, prev => ({
    version: prev?.version ?? VERSION,
    engine: prev?.engine ?? 'unknown',
    surface: prev?.surface ?? 'none',
    loadedAt: prev?.loadedAt ?? 0,
    reloads: prev?.reloads ?? 1,
    panels: prev?.panels ?? [],
    failures: [...failures],
  }))
}

/** `/tower`: what loaded and what is on, in one screen. */
export const registerDiag: Feature = (on, options) => {
  on('command.run', { command: 'tower' }, async $ => {
    const d = await readDiag($)
    if (!d) return { text: 'Tower is loaded, but this session has not started it yet.' }
    const now = await $.clock.now()
    const quiet = String(options.quietHours ?? '')
    const failures = d.failures ?? []
    return {
      text: [
        `Tower v${d.version}`,
        '',
        `  engine     ${d.engine}`,
        `  surface    ${d.surface}`,
        `  loaded     ${since(now - d.loadedAt)} ago (load ${d.reloads} this session)`,
        `  panels     ${d.panels.length > 0 ? d.panels.join(', ') : 'none switched on'}`,
        `  notify     ${String(options.notifyLevel ?? 'silent')}`,
        `  watchdog   ${String(options.tankWatchdog ?? 'alert')}`,
        `  quiet      ${quiet === '' ? 'off' : quiet}`,
        ...(failures.length > 0
          ? ['', `  ${failures.length} feature${failures.length === 1 ? '' : 's'} did not start:`, ...failures.map(f => `    ✗ ${f}`)]
          : []),
        '',
        'Change any of these in /config, under Tower.',
      ].join('\n'),
    }
  })
}
