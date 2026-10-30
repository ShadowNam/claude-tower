/**
 * One palette for every panel, so the mod reads as one thing.
 *
 * Every colour is checked against the band's own background, which is the only
 * thing any of them is ever drawn on. Two rules shaped the set:
 *
 * **Nothing that shares a slot may share a hue.** Simulated for deuteranopia
 * and protanopia, the whole warm range collapses into one yellow-olive band —
 * so two states that mean opposite things and occupy the same eleven pixels
 * cannot both be warm. That is why COLD is cyan rather than the amber it used
 * to be: against ORANGE it goes from ΔE 9 to ΔE 89 for a deuteranope.
 *
 * **Where hue cannot separate, lightness must.** The two window meters sit
 * side by side and are already labelled 7D and 5H, so they only need enough
 * ΔL* to be told apart at a glance: 66 against 84 does it.
 */

export const TEXT = '#e6e1d7'
export const DIM = '#8b857a'

/** The unspent part of a meter, and its rim. 1.77:1 on BG — the scale's floor. */
export const EMPTY = '#4a463f'

/** Healthy, and a warm cache. L* 72. */
export const OK = '#86c06a'

/**
 * A cold cache. Cyan, not amber: this and ORANGE are drawn in the same row and
 * the state orb carries its meaning in colour alone, with no adjacent glyph.
 */
export const COLD = '#58b0cf'

/** Something is going wrong. L* 59, and paired with a different silhouette. */
export const BAD = '#e8635a'

/** A window running out, an estimate overrunning. Never a cache state now. */
export const WARN = '#e8a33d'

/** A window keeps its own colour wherever it is drawn. */
export const ORANGE = '#e8893c'
export const YELLOW = '#edd05c'

/**
 * The bar the band is drawn on, and the ink for a word on a filled badge.
 * Every drawing paints BG as its own floor rather than relying on this Box,
 * so a drawing is self-contained and cannot invert on a surface that paints
 * something else behind it.
 */
export const BG = '#211e1a'
export const INK = '#17150f'
