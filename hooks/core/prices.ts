/**
 * List prices in USD per million tokens, as published on 2026-10-10:
 * input, output, cache read, cache write at the one-hour TTL.
 *
 * The first pattern that matches wins, so a point release sits above its
 * family. A model the table does not name prices as null rather than as
 * something plausible: the band says it does not know, which is the truth.
 *
 * Derived from the table in johnnyvizz/claude-kit savvy-progress (MIT); see NOTICE.
 */
export type Price = readonly [input: number, output: number, cacheRead: number, cacheWrite: number]

const TABLE: readonly (readonly [RegExp, Price])[] = [
  [/(?:fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

/** The prices for a model, or null when the table does not name it. */
export function priceOf(model: string | null): Price | null {
  if (model === null || model === '') return null
  const id = model.toLowerCase()
  return TABLE.find(([re]) => re.test(id))?.[1] ?? null
}

/** The four token counts the engine reports for a model request. */
export type ModelUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * What one model request cost, or null when the table does not name the model.
 *
 * Null rather than a plausible default on purpose: a wrong number that looks
 * right is worse than an admitted gap, and a new model family is exactly when
 * someone would trust the figure least if they knew.
 *
 * Cache writes are priced at the one-hour rate, which is what this plan uses.
 * A five-minute write would be cheaper, and the engine's usage does not say
 * which it was, so a session that mixes them reads slightly high.
 */
export function costOf(model: string | null, u: ModelUsage): number | null {
  const price = priceOf(model)
  if (price === null) return null
  const [input, output, cacheRead, cacheWrite] = price
  return (
    (u.input_tokens * input +
      u.output_tokens * output +
      u.cache_read_input_tokens * cacheRead +
      u.cache_creation_input_tokens * cacheWrite) /
    1_000_000
  )
}

/**
 * What the next message costs once the cache has gone cold: the whole context
 * written again. Null when the model is unknown or there is nothing to write.
 */
export function rewarmCost(model: string | null, tokens: number): number | null {
  const price = priceOf(model)
  if (price === null || tokens <= 0) return null
  return (tokens * price[3]) / 1_000_000
}
