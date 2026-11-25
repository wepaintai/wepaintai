import { describe, expect, test, vi } from 'vitest'

vi.mock('convex/react', () => ({ useConvex: () => ({}) }))
vi.mock('../lib/webrtc/P2PManager', () => ({ P2PManager: class {} }))

const { editorPeerIdsFromPresence, isPacketFromEditor } = await import('./useP2PPainting')

describe('P2P editor filtering', () => {
  test('editor set comes from presence user ids', () => {
    const ids = editorPeerIdsFromPresence([{ userId: 'u1' }, { userId: null }, {}, { userId: 'u2' }])
    expect([...ids].sort()).toEqual(['u1', 'u2'])
  })

  test('packets from peers outside the editor set are ignored', () => {
    const editors = editorPeerIdsFromPresence([{ userId: 'owner' }, { userId: 'collab' }])
    expect(isPacketFromEditor('collab', editors)).toBe(true)
    // After revoke the server clears the collaborator's presence row
    const afterRevoke = editorPeerIdsFromPresence([{ userId: 'owner' }])
    expect(isPacketFromEditor('collab', afterRevoke)).toBe(false)
    // No filter supplied: legacy behavior
    expect(isPacketFromEditor('anyone', null)).toBe(true)
  })
})
