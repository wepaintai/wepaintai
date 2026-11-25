/**
 * Drop optimistic (pending) strokes whose backend copy has arrived.
 *
 * `confirmedIds` must come from the backend strokes *before* any optimistic
 * undo filtering: a stroke undone while its save was in flight is still
 * confirmed, and if it were missing here its optimistic copy would never be
 * cleared (it would stay on the canvas until the 30 s cleanup).
 *
 * Returns `prev` unchanged when nothing was confirmed, so React can bail out.
 * Confirmed entries are removed from `backendIdByTempId` as a side effect.
 */
export function reconcilePendingStrokes<T>(
  prev: Map<string, T>,
  backendIdByTempId: Map<string, string | null>,
  confirmedIds: ReadonlySet<string>,
): Map<string, T> {
  let next: Map<string, T> | null = null
  for (const tempId of prev.keys()) {
    const backendId = backendIdByTempId.get(tempId)
    if (backendId && confirmedIds.has(backendId)) {
      next ??= new Map(prev)
      next.delete(tempId)
      backendIdByTempId.delete(tempId)
    }
  }
  return next ?? prev
}
