import { describe, expect, test } from 'vitest'
import { holdCapabilitiesWhileLoading, resolveSessionCapabilities } from './sessionCapabilities'

const local = (currentUserId: string | null = null, hasGuestKey = false) => ({ currentUserId, hasGuestKey })

describe('resolveSessionCapabilities', () => {
  test('uses the backend capability fields when present', () => {
    const session = { createdBy: 'owner', isPublic: true }
    expect(
      resolveSessionCapabilities({ status: 'ok', session, canEdit: false, isOwner: false }, local('owner')),
    ).toEqual({ canEdit: false, isOwner: false, legacyBackend: false })
    expect(
      resolveSessionCapabilities({ status: 'ok', session, canEdit: true, isOwner: false }, local()),
    ).toEqual({ canEdit: true, isOwner: false, legacyBackend: false })
  })

  test('an old backend (no canEdit) never makes the owner read-only', () => {
    // Signed-in owner of a private session
    expect(
      resolveSessionCapabilities({ status: 'ok', session: { createdBy: 'u1', isPublic: false } }, local('u1')),
    ).toEqual({ canEdit: true, isOwner: true, legacyBackend: true })
    // Guest owner holding the guest key
    expect(
      resolveSessionCapabilities(
        { status: 'ok', session: { hasGuestOwner: true, isPublic: false } },
        local(null, true),
      ),
    ).toEqual({ canEdit: true, isOwner: true, legacyBackend: true })
    // Old backend: public sessions were editable by everyone
    expect(
      resolveSessionCapabilities({ status: 'ok', session: { createdBy: 'u1', isPublic: true } }, local('u2')),
    ).toEqual({ canEdit: true, isOwner: false, legacyBackend: true })
  })

  test('non-ok results grant nothing', () => {
    for (const result of [undefined, null, { status: 'not_found' as const }, { status: 'unauthorized' as const }]) {
      expect(resolveSessionCapabilities(result, local('u1', true))).toEqual({
        canEdit: false,
        isOwner: false,
        legacyBackend: false,
      })
    }
  })
})

describe('holdCapabilitiesWhileLoading', () => {
  const editor = { sessionId: 's1', canEdit: true, isOwner: false }
  const readOnly = { canEdit: false, isOwner: false }

  test('keeps the last capabilities while the same session reloads', () => {
    expect(
      holdCapabilitiesWhileLoading({ sessionId: 's1', sessionResult: undefined, resolved: readOnly, last: editor })
    ).toEqual({ canEdit: true, isOwner: false })
  })

  test('never carries capabilities over to a different session', () => {
    expect(
      holdCapabilitiesWhileLoading({ sessionId: 's2', sessionResult: undefined, resolved: readOnly, last: editor })
    ).toEqual(readOnly)
  })

  test('applies a resolved result immediately, including a revocation', () => {
    expect(
      holdCapabilitiesWhileLoading({
        sessionId: 's1',
        sessionResult: { status: 'ok', session: {}, canEdit: false, isOwner: false },
        resolved: readOnly,
        last: editor,
      })
    ).toEqual(readOnly)
    expect(
      holdCapabilitiesWhileLoading({ sessionId: 's1', sessionResult: { status: 'unauthorized' }, resolved: readOnly, last: editor })
    ).toEqual(readOnly)
  })

  test('is read-only on first load with nothing held', () => {
    expect(
      holdCapabilitiesWhileLoading({ sessionId: 's1', sessionResult: undefined, resolved: readOnly, last: null })
    ).toEqual(readOnly)
  })
})
