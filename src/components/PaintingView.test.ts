// @vitest-environment happy-dom
//
// Mounts the REAL PaintingView editor tree (PaintingView -> PaintingEditorProvider
// -> KonvaCanvas / ToolPanel / PresenceStrip / TokenDisplay / ...) under
// React.StrictMode and checks that it wires the shared PaintingEditorContext
// correctly for each access role. Only the leaves are faked: the Convex React
// hooks, the presence client, the P2PManager, the Better Auth client and the
// Konva canvas renderer (happy-dom has no 2D canvas).
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getFunctionName, type FunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { P2PManagerOptions } from '../lib/webrtc/P2PManager'

function fnKey(ref: unknown): string {
  return getFunctionName(ref as FunctionReference<'query' | 'mutation' | 'action'>)
}

interface MockP2PInstance {
  options: P2PManagerOptions
  init: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

interface RecordedCall {
  kind: 'query' | 'mutation' | 'action' | 'presence' | 'client'
  name: string
  args: Record<string, unknown> | undefined
}

const {
  activeSubscriptions,
  actionMockMap,
  authState,
  mockConvexClient,
  mutationMockMap,
  p2pInstances,
  presenceState,
  queryCalls,
  queryResponseMap,
} = vi.hoisted(() => ({
  // Every non-skipped useQuery render, in order (not just the last args per name)
  queryCalls: [] as Array<{ name: string; args: Record<string, unknown> | undefined }>,
  activeSubscriptions: new Map<string, number>(),
  mutationMockMap: new Map<string, ReturnType<typeof vi.fn>>(),
  actionMockMap: new Map<string, ReturnType<typeof vi.fn>>(),
  queryResponseMap: new Map<string, unknown>(),
  mockConvexClient: {
    mutation: vi.fn(async () => ({ peers: [], mode: 'mesh' })),
    query: vi.fn(async () => []),
    action: vi.fn(async () => undefined),
  },
  p2pInstances: [] as MockP2PInstance[],
  presenceState: {
    self: new Map<string, { presenceId: string; leaveToken: string }>(),
    authenticated: true,
    mutation: null as null | ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>,
  },
  authState: { isSignedIn: false },
}))

vi.mock('convex/react', async () => {
  const react = await import('react')
  const { getFunctionName: name } = await import('convex/server')
  const keyOf = (ref: unknown) => name(ref as FunctionReference<'query'>)
  class MockConvexReactClient {
    connectionState() {
      return { isWebSocketConnected: true }
    }
    subscribeToConnectionState() {
      return () => {}
    }
    mutation = mockConvexClient.mutation
    query = mockConvexClient.query
    action = mockConvexClient.action
  }
  return {
    ConvexReactClient: MockConvexReactClient,
    useQuery: (queryRef: unknown, args?: unknown) => {
      const fn = keyOf(queryRef)
      const isActive = args !== 'skip'
      react.useEffect(() => {
        if (!isActive) return
        activeSubscriptions.set(fn, (activeSubscriptions.get(fn) ?? 0) + 1)
        return () => {
          const remaining = (activeSubscriptions.get(fn) ?? 1) - 1
          if (remaining <= 0) activeSubscriptions.delete(fn)
          else activeSubscriptions.set(fn, remaining)
        }
      }, [fn, isActive])
      if (!isActive) return undefined
      queryCalls.push({ name: fn, args: args as Record<string, unknown> | undefined })
      const response = queryResponseMap.get(fn)
      return typeof response === 'function' ? response(args ?? {}) : response
    },
    useMutation: (mutationRef: unknown) => {
      const fn = keyOf(mutationRef)
      let mock = mutationMockMap.get(fn)
      if (!mock) {
        mock = vi.fn(async () => undefined)
        mutationMockMap.set(fn, mock)
      }
      return mock
    },
    useAction: (actionRef: unknown) => {
      const fn = keyOf(actionRef)
      let mock = actionMockMap.get(fn)
      if (!mock) {
        mock = vi.fn(async () => undefined)
        actionMockMap.set(fn, mock)
      }
      return mock
    },
    useConvex: () => mockConvexClient,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: authState.isSignedIn }),
  }
})

// Avoid pulling ConvexBetterAuthProvider & a real client into the tree; only
// useConnectionStatus reads convexHigh.
vi.mock('../lib/convex', () => ({
  convexHigh: {
    connectionState: () => ({ isWebSocketConnected: true }),
    subscribeToConnectionState: () => () => {},
  },
}))

vi.mock('../lib/auth-client', () => ({
  useAuthState: () => ({
    isLoaded: true,
    isSignedIn: authState.isSignedIn,
    user: authState.isSignedIn ? { id: 'auth_1', name: 'Alice' } : null,
    userId: authState.isSignedIn ? 'auth_1' : null,
  }),
  authClient: {
    useSession: () => ({
      data: authState.isSignedIn ? { user: { id: 'auth_1' } } : null,
      isPending: false,
    }),
    signOut: vi.fn(async () => undefined),
    signIn: { social: vi.fn(async () => ({})) },
  },
}))

// Presence runs on its own Convex client (src/lib/presenceClient.ts).
vi.mock('../lib/presenceClient', () => ({
  getPresenceClient: () => ({
    mutation: (...args: unknown[]) => presenceState.mutation?.(...args),
  }),
  getPresenceAuthState: () => ({ ready: true, authenticated: presenceState.authenticated }),
  getSelfPresence: (sessionId: string | null | undefined) =>
    sessionId ? (presenceState.self.get(sessionId) ?? null) : null,
  setSelfPresence: (
    sessionId: string,
    value: { presenceId: string; leaveToken: string } | null
  ) => {
    if (value) presenceState.self.set(sessionId, value)
    else presenceState.self.delete(sessionId)
  },
  useSelfPresenceId: (sessionId: string | null | undefined) =>
    sessionId ? presenceState.self.get(sessionId)?.presenceId : undefined,
}))

vi.mock('../lib/webrtc/P2PManager', () => ({
  P2PManager: class MockP2PManager {
    options: P2PManagerOptions
    init = vi.fn(async () => {
      this.options.onModeChanged?.('mesh')
    })
    destroy = vi.fn(async () => undefined)
    sendPacket = vi.fn()
    sendCursorPacket = vi.fn()
    getMetrics = vi.fn(() => ({
      latency: 12,
      packetsSent: 0,
      packetsReceived: 0,
      bytesTransferred: 0,
      connectedPeers: 0,
    }))

    constructor(options: P2PManagerOptions) {
      this.options = options
      p2pInstances.push(this)
    }
  },
}))

// happy-dom has no 2D canvas: render Konva containers as plain pass-through
// nodes and Konva leaves as nothing. Refs stay null, which KonvaCanvas guards.
vi.mock('react-konva', async () => {
  const react = await import('react')
  const passThrough = (displayName: string) => {
    const C = react.forwardRef<unknown, { children?: React.ReactNode }>((props, _ref) =>
      react.createElement('div', { 'data-konva': displayName }, props.children)
    )
    C.displayName = displayName
    return C
  }
  const leaf = (displayName: string) => {
    const C = react.forwardRef<unknown, object>(() => null)
    C.displayName = displayName
    return C
  }
  return {
    Stage: passThrough('Stage'),
    Layer: passThrough('Layer'),
    Group: passThrough('Group'),
    Path: leaf('Path'),
    Image: leaf('Image'),
    Circle: leaf('Circle'),
    Text: leaf('Text'),
    Arc: leaf('Arc'),
    Transformer: leaf('Transformer'),
    Line: leaf('Line'),
  }
})
vi.mock('konva', () => ({ default: {} }))
// LibraryModal (always mounted by ToolPanel) navigates via the router.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import { PaintingView } from './PaintingView'
import { getEditKey, removeEditKey, setGuestKey } from '../utils/guestKey'

const SESSION_ID = 'session_abc'
const USER_ID = 'user_123'
const GUEST_KEY = 'guest-secret'
const EDIT_KEY = 'edit-secret'

// Queries the tree may legitimately issue without a session id.
const SESSIONLESS_QUERIES = new Set([
  fnKey(api.auth.getCurrentUser),
  fnKey(api.tokens.getTokenBalance),
  fnKey(api.polar.getTokenPackages),
  fnKey(api.paintingSessions.getUserSessions),
])

// The session-scoped subscriptions the editor tree is expected to hold.
const SESSION_QUERIES = [
  api.paintingSessions.getSession,
  api.strokes.getSessionStrokes,
  api.presence.getSessionPresence,
  api.strokes.getUndoRedoAvailability,
  api.viewerAcks.getViewerState,
  api.images.getSessionImages,
  api.paintLayers.getPaintLayers,
].map(fnKey)

type Role = 'guest-owner' | 'user-owner' | 'collaborator' | 'viewer'

function sessionDoc(overrides: Record<string, unknown>) {
  return {
    _id: SESSION_ID,
    _creationTime: 1,
    name: 'Test Painting',
    isPublic: false,
    canvasWidth: 800,
    canvasHeight: 600,
    strokeCounter: 0,
    ...overrides,
  }
}

/**
 * Seed Convex responses. getSession emulates the server's access check, so a
 * tree that forgets to forward the role's key is denied (and the test fails)
 * instead of silently getting an editor view.
 */
function seedSession(role: Role) {
  authState.isSignedIn = role !== 'guest-owner'
  presenceState.authenticated = authState.isSignedIn
  queryResponseMap.set(
    fnKey(api.auth.getCurrentUser),
    authState.isSignedIn ? { _id: USER_ID, name: 'Alice', email: 'alice@example.com' } : null
  )
  queryResponseMap.set(
    fnKey(api.paintingSessions.getSession),
    (args: { sessionId?: string; guestKey?: string; editKey?: string }) => {
      if (args.sessionId !== SESSION_ID) return { status: 'not_found' }
      switch (role) {
        case 'guest-owner':
          return args.guestKey === GUEST_KEY
            ? {
                status: 'ok',
                canEdit: true,
                isOwner: true,
                session: sessionDoc({ hasGuestOwner: true }),
              }
            : { status: 'unauthorized' }
        case 'user-owner':
          return {
            status: 'ok',
            canEdit: true,
            isOwner: true,
            session: sessionDoc({ createdBy: USER_ID, hasGuestOwner: false }),
          }
        case 'collaborator':
          return args.editKey === EDIT_KEY
            ? {
                status: 'ok',
                canEdit: true,
                isOwner: false,
                session: sessionDoc({ createdBy: 'someone_else', hasGuestOwner: false }),
              }
            : { status: 'unauthorized' }
        case 'viewer':
          return {
            status: 'ok',
            canEdit: false,
            isOwner: false,
            session: sessionDoc({
              createdBy: 'someone_else',
              hasGuestOwner: false,
              isPublic: true,
            }),
          }
      }
    }
  )
  queryResponseMap.set(fnKey(api.strokes.getSessionStrokes), [])
  queryResponseMap.set(fnKey(api.presence.getSessionPresence), [])
  queryResponseMap.set(fnKey(api.strokes.getUndoRedoAvailability), {
    canUndo: false,
    canRedo: false,
  })
  queryResponseMap.set(fnKey(api.viewerAcks.getViewerState), null)
  // Empty paint-layer list: editors must ensure the default layer on mount.
  queryResponseMap.set(fnKey(api.paintLayers.getPaintLayers), [])
  // Two image layers so the Layers tab has owner-deletable rows.
  queryResponseMap.set(fnKey(api.images.getSessionImages), [
    {
      _id: 'upload_1',
      _creationTime: 100,
      sessionId: SESSION_ID,
      storageId: 'storage_1',
      filename: 'bg.png',
      mimeType: 'image/png',
      width: 800,
      height: 600,
      x: 400,
      y: 300,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 1,
      url: 'https://cdn.example/bg.png',
      type: 'uploaded',
    },
    {
      _id: 'ai_1',
      _creationTime: 200,
      sessionId: SESSION_ID,
      storageId: null,
      filename: 'ai-generated.png',
      mimeType: 'image/png',
      imageUrl: 'https://cdn.example/ai-1.png',
      url: 'https://cdn.example/ai-1.png',
      width: 512,
      height: 512,
      x: 256,
      y: 256,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 2,
      createdAt: 200,
      type: 'ai-generated',
    },
  ])
  queryResponseMap.set(fnKey(api.tokens.getTokenBalance), { tokens: 10 })
  queryResponseMap.set(fnKey(api.polar.getTokenPackages), [])
  queryResponseMap.set(fnKey(api.paintingSessions.getUserSessions), [])
}

function mutationArgs(ref: unknown): Record<string, unknown>[] {
  const mock = mutationMockMap.get(fnKey(ref))
  return (mock?.mock.calls ?? []).map((call) => call[0] as Record<string, unknown>)
}

/** Every Convex call (query render, mutation, action, presence) the tree issued. */
function allCalls(): RecordedCall[] {
  const calls: RecordedCall[] = queryCalls.map((c) => ({ kind: 'query', ...c }))
  for (const [name, mock] of mutationMockMap) {
    for (const call of mock.mock.calls) {
      calls.push({ kind: 'mutation', name, args: call[0] as Record<string, unknown> })
    }
  }
  for (const [name, mock] of actionMockMap) {
    for (const call of mock.mock.calls) {
      calls.push({ kind: 'action', name, args: call[0] as Record<string, unknown> })
    }
  }
  for (const call of presenceState.mutation?.mock.calls ?? []) {
    calls.push({
      kind: 'presence',
      name: fnKey(call[0]),
      args: call[1] as Record<string, unknown>,
    })
  }
  for (const client of [
    mockConvexClient.mutation,
    mockConvexClient.query,
    mockConvexClient.action,
  ]) {
    for (const call of client.mock.calls as unknown[][]) {
      calls.push({ kind: 'client', name: fnKey(call[0]), args: call[1] as Record<string, unknown> })
    }
  }
  return calls
}

function sessionScopedCalls(): RecordedCall[] {
  return allCalls().filter((c) => c.args?.sessionId === SESSION_ID)
}

function writeCalls(): RecordedCall[] {
  return allCalls().filter((c) => c.kind !== 'query')
}

function liveManagers() {
  return p2pInstances.filter((m) => m.destroy.mock.calls.length === 0)
}

let container: HTMLElement | null = null
let root: Root | null = null

async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

async function mountPaintingView(url: string) {
  window.history.replaceState({}, '', url)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(React.createElement(React.StrictMode, null, React.createElement(PaintingView)))
  })
  await flush()
}

async function unmountPaintingView() {
  if (root) {
    const r = root
    root = null
    await act(async () => {
      r.unmount()
    })
    await flush(1)
  }
  container?.remove()
  container = null
}

function byLabel(label: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`))
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function openLayersTab() {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
    (el) => el.textContent?.trim() === 'Layers'
  )
  expect(tab, 'Layers tab should be rendered by the real ToolPanel').toBeTruthy()
  await click(tab!)
}

/** Each session-scoped query has exactly one live subscription, and no extra ones exist. */
function expectOneSubscriptionPerSessionQuery() {
  for (const name of SESSION_QUERIES) {
    expect(activeSubscriptions.get(name), name).toBe(1)
  }
  const sessionQueryNames = new Set(
    queryCalls.filter((c) => c.args?.sessionId !== undefined).map((c) => c.name)
  )
  expect([...sessionQueryNames].sort()).toEqual([...SESSION_QUERIES].sort())
  // Anything subscribed without a session id must be a known session-less query
  for (const c of queryCalls) {
    if (c.args?.sessionId === undefined) {
      expect(SESSIONLESS_QUERIES.has(c.name), `unexpected session-less query ${c.name}`).toBe(true)
    }
  }
}

describe('PaintingView (real editor tree) wires PaintingEditorContext per role', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_AUTH_DISABLED', 'false')
    vi.stubEnv('VITE_INTERNAL_HIDE_ADMIN_PANEL', 'true')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    activeSubscriptions.clear()
    mutationMockMap.clear()
    actionMockMap.clear()
    queryResponseMap.clear()
    queryCalls.length = 0
    p2pInstances.length = 0
    mockConvexClient.mutation.mockClear()
    mockConvexClient.query.mockClear()
    mockConvexClient.action.mockClear()
    presenceState.self.clear()
    presenceState.mutation = vi.fn(async () => ({
      presenceId: 'pres_self',
      leaveToken: 'leave-token',
    }))
    window.localStorage.clear()
    window.sessionStorage.clear()
    removeEditKey(SESSION_ID)
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    await unmountPaintingView()
    removeEditKey(SESSION_ID)
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('guest owner (guest key): one subscription per query, default layer ensured, every call carries guestKey', async () => {
    seedSession('guest-owner')
    setGuestKey(SESSION_ID, GUEST_KEY)
    // Our presence row exists, so unmount must send an authorized leave
    presenceState.self.set(SESSION_ID, { presenceId: 'pres_self', leaveToken: 'leave-token' })

    await mountPaintingView(`/?session=${SESSION_ID}`)

    expectOneSubscriptionPerSessionQuery()
    // P2P needs a signed-in identity (useP2PPainting `enabled: !!currentUser.id`),
    // so a guest owner paints over Convex only; see the signed-in owner test.
    expect(p2pInstances).toHaveLength(0)

    // Default paint layer ensured exactly once, with the guest key
    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, guestKey: GUEST_KEY }),
    ])

    // Owner sees owner-only controls (positive control for the collaborator test)
    expect(byLabel('Clear Canvas')).toHaveLength(1)
    expect((byLabel('Clear Canvas')[0] as HTMLButtonElement).disabled).toBe(false)
    await openLayersTab()
    expect(byLabel('Delete layer')).toHaveLength(2)

    // Writes issued through the real UI carry the guest key
    await click(byLabel('Add new paint layer')[0])
    await click(byLabel('Hide layer')[0])
    expect(mutationArgs(api.paintLayers.createPaintLayer)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, guestKey: GUEST_KEY }),
    ])
    const transformArgs = [
      ...mutationArgs(api.images.updateImageTransform),
      ...mutationArgs(api.images.updateAIImageTransform),
    ]
    expect(transformArgs).toEqual([expect.objectContaining({ guestKey: GUEST_KEY })])

    await unmountPaintingView()

    expect(mutationArgs(api.presence.leaveSession)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, guestKey: GUEST_KEY }),
    ])

    const scoped = sessionScopedCalls()
    for (const c of scoped) {
      expect(c.args, `${c.kind} ${c.name}`).toMatchObject({ guestKey: GUEST_KEY })
      expect(c.args?.editKey, `${c.kind} ${c.name}`).toBeUndefined()
    }
  }, 60_000)

  test('signed-in owner: one subscription per query, exactly one live P2PManager, default layer ensured', async () => {
    seedSession('user-owner')

    await mountPaintingView(`/?session=${SESSION_ID}`)

    expectOneSubscriptionPerSessionQuery()

    // StrictMode double-mounts effects; exactly one manager survives and was
    // initialised once.
    expect(liveManagers()).toHaveLength(1)
    expect(liveManagers()[0].init).toHaveBeenCalledTimes(1)
    expect(liveManagers()[0].options).toMatchObject({ sessionId: SESSION_ID, peerId: USER_ID })

    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID }),
    ])

    await openLayersTab()
    expect(byLabel('Delete layer')).toHaveLength(2)

    await unmountPaintingView()
    expect(liveManagers()).toHaveLength(0)
  }, 60_000)

  test('edit-link collaborator (#edit= fragment): every call carries editKey and owner-only controls are hidden', async () => {
    seedSession('collaborator')
    presenceState.self.set(SESSION_ID, { presenceId: 'pres_self', leaveToken: 'leave-token' })

    await mountPaintingView(`/?session=${SESSION_ID}#edit=${EDIT_KEY}`)

    // consumeEditKeyFromWindowUrl captured the key and scrubbed the fragment
    expect(getEditKey(SESSION_ID)).toBe(EDIT_KEY)
    expect(window.location.hash).not.toContain('edit')
    expect(window.location.href).not.toContain(EDIT_KEY)

    expectOneSubscriptionPerSessionQuery()

    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, editKey: EDIT_KEY }),
    ])
    expect(liveManagers()).toHaveLength(1)
    expect(liveManagers()[0].options.editKey).toBe(EDIT_KEY)

    // Editing UI is present, owner-only controls are not
    expect(byLabel('Clear Canvas')).toHaveLength(0)
    const clearButton = byLabel('Only the owner can clear the canvas')
    expect(clearButton).toHaveLength(1)
    expect((clearButton[0] as HTMLButtonElement).disabled).toBe(true)
    await openLayersTab()
    expect(byLabel('Hide layer').length).toBeGreaterThan(0)
    expect(byLabel('Delete layer')).toHaveLength(0)

    await click(byLabel('Add new paint layer')[0])
    await click(byLabel('Hide layer')[0])
    expect(mutationArgs(api.paintLayers.createPaintLayer)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, editKey: EDIT_KEY }),
    ])
    const transformArgs = [
      ...mutationArgs(api.images.updateImageTransform),
      ...mutationArgs(api.images.updateAIImageTransform),
    ]
    expect(transformArgs).toEqual([expect.objectContaining({ editKey: EDIT_KEY })])

    // Owner-only writes were never sent
    for (const ref of [
      api.paintLayers.deletePaintLayer,
      api.images.deleteImage,
      api.images.deleteAIImage,
      api.strokes.clearSession,
      api.liveStrokes.clearSessionLiveStrokes,
    ]) {
      expect(mutationArgs(ref), fnKey(ref)).toHaveLength(0)
    }

    await unmountPaintingView()

    // Leaving the session (presence + viewer state) is authorized by the edit link too
    expect(mutationArgs(api.presence.leaveSession)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, editKey: EDIT_KEY }),
    ])
    expect(mutationArgs(api.viewerAcks.removeViewerState)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, editKey: EDIT_KEY }),
    ])

    const scoped = sessionScopedCalls()
    for (const c of scoped) {
      expect(c.args, `${c.kind} ${c.name}`).toMatchObject({ editKey: EDIT_KEY })
      expect(c.args?.guestKey, `${c.kind} ${c.name}`).toBeUndefined()
    }
  }, 60_000)

  test('read-only public viewer: no P2PManager, no default-layer creation, no writes on mount', async () => {
    seedSession('viewer')

    await mountPaintingView(`/?session=${SESSION_ID}`)

    // The viewer still gets the session (one subscription per query)...
    expectOneSubscriptionPerSessionQuery()

    // ...but no P2P (signed in, so this is gated on canEdit, not on identity)
    expect(p2pInstances).toHaveLength(0)
    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toHaveLength(0)

    // Advance past the presence heartbeat & thumbnail intervals
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    await flush()

    // No mutation/action of any kind, on any client, before unmount
    expect(writeCalls()).toEqual([])

    // No editing affordances
    await openLayersTab()
    expect(byLabel('Add new paint layer')).toHaveLength(0)
    expect(byLabel('Delete layer')).toHaveLength(0)
    expect(writeCalls()).toEqual([])
  }, 60_000)
})
