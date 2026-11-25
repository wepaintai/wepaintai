import { describe, expect, test } from 'vitest'
import { resolveSessionCapabilities } from './sessionCapabilities'

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
