// Categorical colours for overlaid trends.
//
// The eight hues and their per-mode steps come from the reference data-viz
// palette and are validated against this dashboard's own chart surfaces
// (#ffffff light, #171b22 dark): every slot clears the lightness band, the
// chroma floor, adjacent-pair CVD separation and the normal-vision floor. Three
// light-mode slots sit under 3:1 contrast, which is why every series also
// carries a direct label at the end of its line — colour is never the only
// thing telling two trends apart.
//
// The values themselves live in index.css as --series-N so light and dark swap
// in one place; this module only decides which slot an entity gets.

/** Slots defined in index.css. */
export const SERIES_SLOTS = 8

/** Most series the chart will draw at once. */
export const MAX_SERIES = 4

/**
 * Colour for a tag, by its position in the full discovered tag list.
 *
 * Keyed on the entity, never on its rank among the *visible* series: hiding one
 * trend must not repaint the ones left behind, or the eye re-learns the chart
 * every time the selection changes.
 *
 * Past the eighth tag the hue would have to be reused, and a duplicated hue
 * says "same thing" when it means nothing at all. Those fall back to a neutral
 * that reads as unclassified rather than as a ninth category.
 */
export function colorForIndex(index) {
  if (index == null || index < 0 || index >= SERIES_SLOTS) return 'var(--series-other)'
  return `var(--series-${index + 1})`
}
