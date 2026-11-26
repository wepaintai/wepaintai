/**
 * Derive the caller's edit/owner capabilities from a getSession result.
 *
 * A backend that predates AUD-005 returns `{ status: 'ok', session }` without
 * `canEdit` / `isOwner`. During a frontend-first (or mixed) deploy, treating
 * the missing fields as `false` would make every canvas read-only, owners
 * included. Missing fields are "unknown" instead and fall back to the old
 * backend's behavior: the old backend only returned a session to its owner or
 * for a public session, and allowed edits in both cases; ownership is
 * inferred locally from `createdBy` or a held guest owner key.
 */
export interface SessionLike {
  createdBy?: string | null
  hasGuestOwner?: boolean
  isPublic?: boolean
}

export type SessionResultLike =
  | { status: 'ok'; session: SessionLike; canEdit?: boolean; isOwner?: boolean }
  | { status: 'not_found' }
  | { status: 'unauthorized' }
  | undefined
  | null

export function resolveSessionCapabilities(
  result: SessionResultLike,
  local: { currentUserId: string | null | undefined; hasGuestKey: boolean },
): { canEdit: boolean; isOwner: boolean; legacyBackend: boolean } {
  if (!result || result.status !== 'ok') {
    return { canEdit: false, isOwner: false, legacyBackend: false }
  }
  const hasCanEdit = typeof result.canEdit === 'boolean'
  const hasIsOwner = typeof result.isOwner === 'boolean'
  const inferredOwner =
    (!!local.currentUserId && result.session.createdBy === local.currentUserId) ||
    (!!result.session.hasGuestOwner && local.hasGuestKey)
  const isOwner = hasIsOwner ? (result.isOwner as boolean) : inferredOwner
  const canEdit = hasCanEdit
    ? (result.canEdit as boolean)
    : isOwner || !!result.session.isPublic
  return { canEdit, isOwner, legacyBackend: !hasCanEdit }
}

/**
 * While a getSession query is reloading (result `undefined`) for the same
 * session, keep the last resolved capabilities instead of dropping to
 * read-only. Any resolved result (including a revocation) wins immediately,
 * and a different session never inherits another session's capabilities.
 */
export function holdCapabilitiesWhileLoading({
  sessionId,
  sessionResult,
  resolved,
  last,
}: {
  sessionId: string | null | undefined
  sessionResult: unknown
  resolved: { canEdit: boolean; isOwner: boolean }
  last: { sessionId: string; canEdit: boolean; isOwner: boolean } | null
}): { canEdit: boolean; isOwner: boolean } {
  if (sessionResult === undefined && sessionId && last && last.sessionId === sessionId) {
    return { canEdit: last.canEdit, isOwner: last.isOwner }
  }
  return { canEdit: resolved.canEdit, isOwner: resolved.isOwner }
}
