import type { Register } from 'claude-code'

/** The `on` and `options` the engine hands `register`, named so features can take them. */
export type On = Parameters<Register>[0]
export type Options = Parameters<Register>[1]

/**
 * One feature of the mod. `hooks.json` takes a single module path, so every
 * feature is a plain function the entry module calls, not a module of its own.
 */
export type Feature = (on: On, options: Options) => void
