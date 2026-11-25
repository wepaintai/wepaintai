import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getFunctionName, type FunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { P2PManagerOptions } from '../lib/webrtc/P2PManager'
import type { P2PPacket } from '../lib/webrtc/types'

function fnKey(ref: unknown): string {
  return getFunctionName(ref as FunctionReference<'query' | 'mutation' | 'action'>)
}

interface MockP2PInstance {
  options: P2PManagerOptions
  init: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  sendPacket: ReturnType<typeof vi.fn>
  sendCursorPacket: ReturnType<typeof vi.fn>
  getMetrics: ReturnType<typeof vi.fn>
}

// Hoist mock registries so vi.mock factories can reference them safely.
const {
  activeSubscriptions,
  mutationMockMap,
  queryResponseMap,
  mockConvexClient,
  p2pInstances,
  presenceState,
  queryArgs,
} = vi.hoisted(() => ({
  queryArgs: new Map<string, unknown>(),
  activeSubscriptions: new Map<string, number>(),
  mutationMockMap: new Map<string, ReturnType<typeof vi.fn>>(),
  queryResponseMap: new Map<string, unknown>(),
  mockConvexClient: {
    mutation: vi.fn(async () => ({ peers: [], mode: 'mesh' })),
    query: vi.fn(async () => []),
  },
  p2pInstances: [] as MockP2PInstance[],
  presenceState: {
    self: new Map<string, { presenceId: string; leaveToken: string }>(),
    authenticated: true,
    mutation: null as null | ((...args: unknown[]) => Promise<unknown>),
  },
}))

// Presence runs on its own Convex client (src/lib/presenceClient.ts).
vi.mock('../lib/presenceClient', () => ({
  getPresenceClient: () => ({
    mutation: (...args: unknown[]) => presenceState.mutation?.(...args),
  }),
  getPresenceAuthState: () => ({ ready: true, authenticated: presenceState.authenticated }),
  getSelfPresence: (sessionId: string | null | undefined) =>
    sessionId ? presenceState.self.get(sessionId) ?? null : null,
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

vi.mock('convex/react', async () => {
  const react = await import('react')
  return {
    ConvexReactClient: class MockConvexReactClient {
      connectionState() {
        return { isWebSocketConnected: true }
      }
      mutation = mockConvexClient.mutation
      query = mockConvexClient.query
    },
    useQuery: (queryRef: unknown, args?: unknown) => {
      const name = getFunctionName(queryRef as FunctionReference<'query'>)
      const isActive = args !== 'skip'
      react.useEffect(() => {
        if (!isActive) return
        activeSubscriptions.set(name, (activeSubscriptions.get(name) ?? 0) + 1)
        return () => {
          const remaining = (activeSubscriptions.get(name) ?? 1) - 1
          if (remaining <= 0) {
            activeSubscriptions.delete(name)
          } else {
            activeSubscriptions.set(name, remaining)
          }
        }
      }, [name, isActive])
      if (!isActive) return undefined
      queryArgs.set(name, args)
      const response = queryResponseMap.get(name)
      return typeof response === 'function' ? response(args) : response
    },
    useMutation: (mutationRef: unknown) => {
      const name = getFunctionName(mutationRef as FunctionReference<'mutation'>)
      let fn = mutationMockMap.get(name)
      if (!fn) {
        fn = vi.fn(async () => undefined)
        mutationMockMap.set(name, fn)
      }
      return fn
    },
    useConvex: () => mockConvexClient,
  }
})

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

import {
  buildEditorLayers,
  PaintingEditorProvider,
  usePaintingEditor,
  usePaintingEditorController,
  type PaintLayerDoc,
  type PaintingEditorContextValue,
} from './PaintingEditorContext'
import type { AISessionImage, UploadedSessionImage } from '../hooks/useSessionImages'
import { useP2PMetrics, useRemoteCursors } from '../lib/webrtc/p2pLiveStore'
import { removeEditKey, setEditKey } from '../utils/guestKey'

// Minimal DOM shim so react-dom/client's createRoot + act() run hooks and effects
// cleanly inside Vitest's edge-runtime environment without adding jsdom.
class FakeNode {
  nodeType: number
  nodeName: string
  tagName: string
  ownerDocument: FakeDocument | null
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  textContent: string | null = ''
  style: Record<string, string> = {}

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.tagName = nodeName
    this.ownerDocument = ownerDocument
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(child)
    if (idx !== -1) this.childNodes.splice(idx, 1)
    child.parentNode = null
    return child
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const idx = before ? this.childNodes.indexOf(before) : -1
    if (idx === -1) this.childNodes.push(child)
    else this.childNodes.splice(idx, 0, child)
    return child
  }

  addEventListener() {}
  removeEventListener() {}
}

class FakeDocument extends FakeNode {
  defaultView: unknown
  activeElement: FakeNode | null = null
  documentElement: FakeNode

  constructor(view: unknown) {
    super(9, '#document', null)
    this.defaultView = view
    this.documentElement = new FakeNode(1, 'HTML', this)
  }

  createElement(tag: string) {
    return new FakeNode(1, tag.toUpperCase(), this)
  }

  createTextNode(text: string) {
    const node = new FakeNode(3, '#text', this)
    node.textContent = text
    return node
  }

  createComment(text: string) {
    const node = new FakeNode(8, '#comment', this)
    node.textContent = text
    return node
  }
}

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  }
}

const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
let activeRoot: Root | null = null
const originalWindow = (globalThis as Record<string, unknown>).window
const originalDocument = (globalThis as Record<string, unknown>).document
const originalActFlag = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT

function setupFakeDom() {
  const storage = createMemoryStorage()
  const fakeWindow: Record<string, unknown> = {
    localStorage: storage,
    HTMLElement: FakeNode,
    HTMLIFrameElement: class FakeHTMLIFrameElement {},
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      let set = windowListeners.get(type)
      if (!set) {
        set = new Set()
        windowListeners.set(type, set)
      }
      set.add(listener)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      windowListeners.get(type)?.delete(listener)
    },
  }
  const fakeDocument = new FakeDocument(fakeWindow)
  fakeWindow.document = fakeDocument

  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as Record<string, unknown>).window = fakeWindow
  ;(globalThis as Record<string, unknown>).document = fakeDocument

  return { container: fakeDocument.createElement('div') as unknown as HTMLElement }
}

function mountTree(element: React.ReactElement) {
  const { container } = setupFakeDom()
  const root = createRoot(container)
  activeRoot = root
  act(() => {
    root.render(element)
  })
  return {
    rerender: (next: React.ReactElement) => {
      act(() => {
        root.render(next)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      activeRoot = null
    },
  }
}

describe('buildEditorLayers', () => {
  test('normalizes paint, uploaded, and AI layers without mutating inputs', () => {
    const sessionId = 'session_layers' as Id<'paintingSessions'>
    const paintLayers: PaintLayerDoc[] = [
      {
        _id: 'paint_1' as Id<'paintLayers'>,
        _creationTime: 10,
        sessionId,
        name: 'Layer 1',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdAt: 10,
      },
    ]
    const uploadedImages: UploadedSessionImage[] = [
      {
        _id: 'upload_1' as Id<'uploadedImages'>,
        _creationTime: 20,
        sessionId,
        storageId: 'storage_1' as Id<'_storage'>,
        filename: 'pic.png',
        mimeType: 'image/png',
        width: 400,
        height: 300,
        x: 200,
        y: 150,
        scale: 1,
        rotation: 0,
        opacity: 0,
        layerOrder: 1,
        url: 'https://cdn.example/pic.png',
        type: 'uploaded',
      },
    ]
    const aiImages: AISessionImage[] = [
      {
        _id: 'ai_1' as Id<'aiGeneratedImages'>,
        _creationTime: 30,
        sessionId,
        imageUrl: 'https://cdn.example/ai.png',
        url: 'https://cdn.example/ai.png',
        width: 512,
        height: 512,
        x: 256,
        y: 256,
        scale: 1,
        rotation: 0,
        opacity: 0.75,
        layerOrder: 2,
        createdAt: 30,
        type: 'ai-generated',
      },
    ]

    const layers = buildEditorLayers({ paintLayers, uploadedImages, aiImages })

    expect(layers).toEqual([
      {
        id: 'paint_1',
        type: 'paint',
        name: 'Layer 1',
        visible: true,
        opacity: 1,
        order: 0,
      },
      {
        id: 'upload_1',
        type: 'image',
        name: 'Upload 1',
        visible: false,
        opacity: 0,
        order: 1,
        thumbnailUrl: 'https://cdn.example/pic.png',
      },
      {
        id: 'ai_1',
        type: 'ai-image',
        name: 'AI Image 1',
        visible: true,
        opacity: 0.75,
        order: 2,
        thumbnailUrl: 'https://cdn.example/ai.png',
      },
    ])
  })
})

describe('PaintingEditorContext deduplication & single-lifecycle invariants', () => {
  const sessionId = 'session_abc' as Id<'paintingSessions'>
  const userId = 'user_123' as Id<'users'>

  beforeEach(() => {
    vi.useFakeTimers()
    activeSubscriptions.clear()
    mutationMockMap.clear()
    queryResponseMap.clear()
    p2pInstances.length = 0
    windowListeners.clear()
    mockConvexClient.mutation.mockClear()
    mockConvexClient.query.mockClear()
    presenceState.self.clear()
    queryArgs.clear()
    removeEditKey('session_abc')
    presenceState.authenticated = true
    presenceState.mutation = vi.fn(async () => ({
      presenceId: 'pres_self',
      leaveToken: 'leave-token',
    }))
  })

  afterEach(() => {
    if (activeRoot) {
      act(() => {
        activeRoot?.unmount()
      })
      activeRoot = null
    }
    vi.useRealTimers()
    ;(globalThis as Record<string, unknown>).window = originalWindow
    ;(globalThis as Record<string, unknown>).document = originalDocument
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActFlag
  })

  function seedAccessibleSession(options?: { authenticated?: boolean }) {
    const authenticated = options?.authenticated ?? true
    queryResponseMap.set(
      fnKey(api.auth.getCurrentUser),
      authenticated
        ? { _id: userId, name: 'Alice', email: 'alice@example.com' }
        : null
    )
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), {
      status: 'ok',
      canEdit: true,
      isOwner: true,
      session: {
        _id: sessionId,
        _creationTime: 1,
        name: 'Test Painting',
        createdBy: authenticated ? userId : undefined,
        hasGuestOwner: !authenticated,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 2,
      },
    })
    queryResponseMap.set(fnKey(api.strokes.getSessionStrokes), [
      {
        _id: 'stroke_1' as Id<'strokes'>,
        _creationTime: 10,
        sessionId,
        userColor: '#000000',
        points: [{ x: 1, y: 1 }],
        brushColor: '#000000',
        brushSize: 10,
        opacity: 1,
        strokeOrder: 1,
      },
      {
        _id: 'stroke_2' as Id<'strokes'>,
        _creationTime: 20,
        sessionId,
        userColor: '#000000',
        points: [{ x: 5, y: 5 }],
        brushColor: '#ff0000',
        brushSize: 10,
        opacity: 1,
        strokeOrder: 2,
      },
    ])
    queryResponseMap.set(fnKey(api.presence.getSessionPresence), [])
    queryResponseMap.set(fnKey(api.strokes.getUndoRedoAvailability), {
      canUndo: true,
      canRedo: false,
    })
    queryResponseMap.set(fnKey(api.viewerAcks.getViewerState), null)
    queryResponseMap.set(fnKey(api.images.getSessionImages), [
      {
        _id: 'upload_1',
        _creationTime: 100,
        sessionId,
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
        sessionId,
        storageId: null,
        filename: 'ai-generated.png',
        mimeType: 'image/png',
        imageUrl: 'https://cdn.example/ai-1.png',
        url: 'https://cdn.example/ai-1.png',
        width: 512,
        height: 512,
        x: 256,
        y: 256,
        scale: 0.8,
        scaleX: 0.8,
        scaleY: 0.8,
        rotation: 0,
        opacity: 1,
        layerOrder: 2,
        createdAt: 200,
        type: 'ai-generated',
      },
    ])
    queryResponseMap.set(fnKey(api.paintLayers.getPaintLayers), [
      {
        _id: 'paint_1' as Id<'paintLayers'>,
        _creationTime: 1,
        sessionId,
        name: 'Layer 1',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdAt: 1,
      },
    ])
  }

  test('mounts each logical Convex subscription once and shares state across multiple consumers', () => {
    seedAccessibleSession({ authenticated: true })

    let viewSnapshot: PaintingEditorContextValue | null = null
    let canvasSnapshot: PaintingEditorContextValue | null = null
    let panelSnapshot: PaintingEditorContextValue | null = null

    function MockCanvasConsumer() {
      canvasSnapshot = usePaintingEditor()
      return null
    }

    function MockPanelConsumer() {
      panelSnapshot = usePaintingEditor()
      return null
    }

    function EditorHarness({ pendingUndo }: { pendingUndo?: ReadonlySet<string> }) {
      const editor = usePaintingEditorController({
        sessionId,
        pendingUndoStrokeIds: pendingUndo,
      })
      viewSnapshot = editor
      return React.createElement(
        PaintingEditorProvider,
        { value: editor },
        React.createElement(MockCanvasConsumer),
        React.createElement(MockPanelConsumer)
      )
    }

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const { rerender, unmount } = mountTree(React.createElement(EditorHarness))

    // Exactly 1 concurrent active subscription per logical dataset (8 total vs 21 previously)
    expect(activeSubscriptions.get(fnKey(api.auth.getCurrentUser))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.paintingSessions.getSession))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.strokes.getSessionStrokes))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.presence.getSessionPresence))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.strokes.getUndoRedoAvailability))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.viewerAcks.getViewerState))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.images.getSessionImages))).toBe(1)
    expect(activeSubscriptions.get(fnKey(api.paintLayers.getPaintLayers))).toBe(1)
    const totalActiveSubscriptions = Array.from(activeSubscriptions.values()).reduce(
      (sum, count) => sum + count,
      0
    )
    expect(totalActiveSubscriptions).toBe(8)

    // Redundant/unused queries are never subscribed
    expect(activeSubscriptions.get(fnKey(api.images.getAIGeneratedImages))).toBeUndefined()
    expect(activeSubscriptions.get(fnKey(api.paintLayer.getPaintLayerSettings))).toBeUndefined()
    expect(activeSubscriptions.get(fnKey(api.liveStrokes.getLiveStrokes))).toBeUndefined()

    // All editor consumers share identical references
    expect(canvasSnapshot).toBe(viewSnapshot)
    expect(panelSnapshot).toBe(viewSnapshot)
    expect(canvasSnapshot!.uploadedImages).toHaveLength(1)
    expect(canvasSnapshot!.aiImages).toHaveLength(1)
    expect(canvasSnapshot!.aiImages[0].imageUrl).toBe('https://cdn.example/ai-1.png')
    expect(canvasSnapshot!.layers.map((l) => l.type)).toEqual(['paint', 'image', 'ai-image'])

    // Exactly ONE P2PManager lifecycle for the authenticated session
    expect(p2pInstances).toHaveLength(1)
    expect(p2pInstances[0].init).toHaveBeenCalledTimes(1)
    expect(p2pInstances[0].options.sessionId).toBe(sessionId)
    expect(p2pInstances[0].options.peerId).toBe(userId)

    // Exactly ONE 20s presence heartbeat timer and ONE pagehide listener
    const heartbeatIntervals = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20000)
    expect(heartbeatIntervals).toHaveLength(1)
    expect(windowListeners.get('pagehide')?.size).toBe(1)

    // Optimistic undo hides the pending stroke consistently for canvas & view
    rerender(
      React.createElement(EditorHarness, {
        pendingUndo: new Set(['stroke_2']),
      })
    )
    expect(canvasSnapshot!.strokes.map((s) => s._id)).toEqual(['stroke_1'])
    expect(viewSnapshot!.rawStrokes.map((s) => s._id)).toEqual(['stroke_1', 'stroke_2'])
    expect(activeSubscriptions.size).toBe(8)

    // Our presence row was established (updatePresence returned a leave token)
    presenceState.self.set(sessionId, { presenceId: 'pres_self', leaveToken: 'leave-token' })

    // Unmount cleans up all subscriptions, the single P2PManager, and single pagehide listener
    unmount()
    expect(activeSubscriptions.size).toBe(0)
    expect(p2pInstances[0].destroy).toHaveBeenCalledTimes(1)
    expect(windowListeners.get('pagehide')?.size).toBe(0)
    // The leave is deferred one tick (so StrictMode remounts don't leave)
    act(() => {
      vi.advanceTimersByTime(0)
    })

    const leaveSessionMock = mutationMockMap.get(fnKey(api.presence.leaveSession))
    expect(leaveSessionMock).toHaveBeenCalledTimes(1)

    setIntervalSpy.mockRestore()
  })

  test('keeps a single stable selfPresenceId & guest identity across auth resolution and skips P2P for guests', () => {
    seedAccessibleSession({ authenticated: false })
    // Simulate initial loading auth state (undefined -> null)
    queryResponseMap.set(fnKey(api.auth.getCurrentUser), undefined)

    let viewSnapshot: PaintingEditorContextValue | null = null
    let canvasSnapshot: PaintingEditorContextValue | null = null

    function CanvasReader() {
      canvasSnapshot = usePaintingEditor()
      return null
    }

    function GuestHarness({ tick }: { tick: number }) {
      void tick
      const editor = usePaintingEditorController({ sessionId })
      viewSnapshot = editor
      return React.createElement(
        PaintingEditorProvider,
        { value: editor },
        React.createElement(CanvasReader)
      )
    }

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { rerender, unmount } = mountTree(React.createElement(GuestHarness, { tick: 0 }))

    const initialUser = viewSnapshot!.currentUser
    expect(initialUser.id).toBeNull()
    expect(initialUser.name).toMatch(/^Guest \d+$/)
    // The guest's per-browser client id is never exposed to other clients;
    // our own presence row is identified by its opaque _id once established.
    expect(viewSnapshot!.selfPresenceId).toBeUndefined()

    // Auth resolves to null (anonymous guest) -> session becomes ready
    queryResponseMap.set(fnKey(api.auth.getCurrentUser), null)
    rerender(React.createElement(GuestHarness, { tick: 1 }))

    // Guest identity remains identical across auth transition & consumers
    expect(viewSnapshot!.currentUser).toBe(initialUser)
    expect(canvasSnapshot!.currentUser).toBe(initialUser)

    // Exactly ONE 20s heartbeat across the auth transition; P2P stays disabled for guests
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20000)).toHaveLength(1)
    expect(p2pInstances).toHaveLength(0)

    unmount()
    setIntervalSpy.mockRestore()
  })

  test('syncs presence cadence with P2P connection and reads latest peer colors without restarting P2PManager', async () => {
    seedAccessibleSession({ authenticated: true })

    let latestEditor: PaintingEditorContextValue | null = null

    function P2PHarness({ tick }: { tick: number }) {
      void tick
      latestEditor = usePaintingEditorController({ sessionId })
      return null
    }

    const { rerender, unmount } = mountTree(React.createElement(P2PHarness, { tick: 0 }))

    expect(p2pInstances).toHaveLength(1)
    const manager = p2pInstances[0]
    const updatePresenceMock = vi.mocked(presenceState.mutation!)

    // Update presence query with a remote peer after P2PManager has already initialized
    queryResponseMap.set(fnKey(api.presence.getSessionPresence), [
      {
        _id: 'pres_peer' as Id<'userPresence'>,
        _creationTime: 1,
        sessionId,
        userId: 'peer_42' as Id<'users'>,
        userColor: '#12ab34',
        userName: 'Bob',
        cursorX: 10,
        cursorY: 20,
        isDrawing: false,
        currentTool: 'brush',
        lastSeen: Date.now(),
      },
    ])
    rerender(React.createElement(P2PHarness, { tick: 1 }))

    // Presence update MUST NOT tear down or recreate the P2PManager
    expect(p2pInstances).toHaveLength(1)
    expect(manager.destroy).not.toHaveBeenCalled()

    // Connect peer -> cadence switches from realtime (250ms) to coarse (20000ms)
    act(() => {
      manager.options.onPeerConnected?.('peer_42')
    })
    expect(latestEditor!.p2p.isConnected).toBe(true)

    // Incoming stroke packet resolves Bob's color from the latest presence ref
    const packet: P2PPacket = { t: 'pt', id: 'stroke99', x: 0.5, y: 0.5, p: 0.5 }
    act(() => {
      manager.options.onPacketReceived?.('peer_42', packet)
    })
    expect(latestEditor!.p2p.liveStore.strokes.get().get('peer_42:stroke99')?.color).toBe('#12ab34')

    // First presence update sends immediately; second update 1s later is throttled by coarse (20s) cadence
    vi.setSystemTime(100_000)
    await act(async () => {
      await latestEditor!.updateUserPresence(10, 10, false, 'brush')
    })
    expect(updatePresenceMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(101_000)
    await act(async () => {
      await latestEditor!.updateUserPresence(20, 20, false, 'brush')
    })
    expect(updatePresenceMock).toHaveBeenCalledTimes(1)

    // Disconnect last peer -> cadence returns to realtime (250ms)
    act(() => {
      manager.options.onPeerDisconnected?.('peer_42')
    })
    expect(latestEditor!.p2p.isConnected).toBe(false)

    vi.setSystemTime(101_500)
    await act(async () => {
      await latestEditor!.updateUserPresence(30, 30, false, 'brush')
    })
    expect(updatePresenceMock).toHaveBeenCalledTimes(2)

    unmount()
  })

  function peerPresenceRow(peerId: string, color = '#12ab34') {
    return {
      _id: `pres_${peerId}` as Id<'userPresence'>,
      _creationTime: 1,
      sessionId,
      userId: peerId as Id<'users'>,
      userColor: color,
      userName: 'Bob',
      cursorX: 10,
      cursorY: 20,
      isDrawing: false,
      currentTool: 'brush',
      lastSeen: Date.now(),
    }
  }

  test('incoming cursor packets and metrics ticks re-render only their subscribers, not the editor host or other consumers', () => {
    seedAccessibleSession({ authenticated: true })
    queryResponseMap.set(fnKey(api.presence.getSessionPresence), [peerPresenceRow('peer_42')])

    const renders = { host: 0, consumer: 0, cursorLayer: 0, metricsBadge: 0 }
    let lastCursors: ReadonlyMap<string, { x: number; y: number; drawing: boolean }> = new Map()

    function PlainConsumer() {
      usePaintingEditor()
      renders.consumer++
      return null
    }
    function CursorLayer() {
      const { p2p } = usePaintingEditor()
      lastCursors = useRemoteCursors(p2p.liveStore)
      renders.cursorLayer++
      return null
    }
    function MetricsBadge() {
      const { p2p } = usePaintingEditor()
      useP2PMetrics(p2p.liveStore)
      renders.metricsBadge++
      return null
    }
    function Host() {
      const editor = usePaintingEditorController({ sessionId })
      renders.host++
      return React.createElement(
        PaintingEditorProvider,
        { value: editor },
        React.createElement(PlainConsumer),
        React.createElement(CursorLayer),
        React.createElement(MetricsBadge)
      )
    }

    const { unmount } = mountTree(React.createElement(Host))
    const manager = p2pInstances[0]
    act(() => {
      manager.options.onPeerConnected?.('peer_42')
    })

    const before = { ...renders }
    act(() => {
      manager.options.onPacketReceived?.('peer_42', { t: 'cu', x: 0.25, y: 0.5, drawing: false })
    })
    act(() => {
      manager.options.onPacketReceived?.('peer_42', { t: 'cu', x: 0.3, y: 0.6, drawing: true })
    })

    expect(lastCursors.get('peer_42')).toEqual({ x: 0.3, y: 0.6, drawing: true })
    expect(renders.cursorLayer).toBe(before.cursorLayer + 2)
    expect(renders.host).toBe(before.host)
    expect(renders.consumer).toBe(before.consumer)
    expect(renders.metricsBadge).toBe(before.metricsBadge)

    // Packets from a peer that isn't a current editor are dropped
    act(() => {
      manager.options.onPacketReceived?.('intruder', { t: 'cu', x: 0.9, y: 0.9, drawing: false })
    })
    expect(lastCursors.has('intruder')).toBe(false)
    expect(renders.cursorLayer).toBe(before.cursorLayer + 2)

    // Metrics ticks: only the badge re-renders, and only when metrics change
    const afterCursors = { ...renders }
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    act(() => {
      vi.advanceTimersByTime(1000) // unchanged metrics: no notification
    })
    expect(renders.metricsBadge).toBe(afterCursors.metricsBadge + 1)
    expect(renders.host).toBe(afterCursors.host)
    expect(renders.consumer).toBe(afterCursors.consumer)
    expect(renders.cursorLayer).toBe(afterCursors.cursorLayer)

    unmount()
  })

  function liveManagers() {
    return p2pInstances.filter((m) => m.destroy.mock.calls.length === 0)
  }

  function mutationArgs(ref: unknown): Record<string, unknown>[] {
    const mock = mutationMockMap.get(fnKey(ref))
    return (mock?.mock.calls ?? []).map((call) => call[0] as Record<string, unknown>)
  }

  test('under React.StrictMode: one subscription per query, one live P2PManager, and no leave on the simulated remount', () => {
    seedAccessibleSession({ authenticated: true })
    // Our presence row already exists (e.g. established on a previous render)
    presenceState.self.set(sessionId, { presenceId: 'pres_self', leaveToken: 'leave-token' })

    let editor: PaintingEditorContextValue | null = null
    function Consumer() {
      usePaintingEditor()
      return null
    }
    function Harness() {
      editor = usePaintingEditorController({ sessionId })
      return React.createElement(
        PaintingEditorProvider,
        { value: editor },
        React.createElement(Consumer)
      )
    }

    const { unmount } = mountTree(
      React.createElement(React.StrictMode, null, React.createElement(Harness))
    )
    act(() => {
      vi.advanceTimersByTime(0)
    })

    for (const ref of [
      api.auth.getCurrentUser,
      api.paintingSessions.getSession,
      api.strokes.getSessionStrokes,
      api.presence.getSessionPresence,
      api.strokes.getUndoRedoAvailability,
      api.viewerAcks.getViewerState,
      api.images.getSessionImages,
      api.paintLayers.getPaintLayers,
    ]) {
      expect(activeSubscriptions.get(fnKey(ref))).toBe(1)
    }
    expect(activeSubscriptions.size).toBe(8)

    // StrictMode mounts effects twice; exactly one manager is left alive and
    // it is the one the editor sends through.
    expect(liveManagers()).toHaveLength(1)
    act(() => {
      liveManagers()[0].options.onPeerConnected?.('peer_42')
    })
    act(() => {
      editor!.p2p.sendStrokePoint('stroke-1234', 0.1, 0.2, 0.5)
    })
    expect(liveManagers()[0].sendPacket).toHaveBeenCalledTimes(1)

    expect(windowListeners.get('pagehide')?.size).toBe(1)
    // The simulated unmount/remount must not leave the session
    expect(mutationMockMap.get(fnKey(api.presence.leaveSession))?.mock.calls.length ?? 0).toBe(0)
    expect(mutationMockMap.get(fnKey(api.viewerAcks.removeViewerState))?.mock.calls.length ?? 0).toBe(0)

    unmount()
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(liveManagers()).toHaveLength(0)
    expect(mutationArgs(api.presence.leaveSession)).toHaveLength(1)
    expect(mutationArgs(api.viewerAcks.removeViewerState)).toHaveLength(1)
  })

  test('a transient return to loading (e.g. the guest-key claim re-running getSession) does not leave the session', () => {
    seedAccessibleSession({ authenticated: true })
    presenceState.self.set(sessionId, { presenceId: 'pres_self', leaveToken: 'leave-token' })
    const sessionResult = queryResponseMap.get(fnKey(api.paintingSessions.getSession))

    let editor: PaintingEditorContextValue | null = null
    function Harness({ tick }: { tick: number }) {
      void tick
      editor = usePaintingEditorController({ sessionId })
      return null
    }
    const { rerender, unmount } = mountTree(React.createElement(Harness, { tick: 0 }))
    expect(editor!.sessionStatus).toBe('ok')

    // getSession args change -> result briefly undefined -> 'loading'
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), undefined)
    rerender(React.createElement(Harness, { tick: 1 }))
    expect(editor!.sessionStatus).toBe('loading')
    act(() => {
      vi.advanceTimersByTime(10)
    })

    queryResponseMap.set(fnKey(api.paintingSessions.getSession), sessionResult)
    rerender(React.createElement(Harness, { tick: 2 }))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(editor!.sessionStatus).toBe('ok')

    expect(mutationArgs(api.presence.leaveSession)).toHaveLength(0)
    expect(mutationArgs(api.viewerAcks.removeViewerState)).toHaveLength(0)
    expect(presenceState.self.get(sessionId)).toBeTruthy()

    unmount()
  })

  test('switching to another session leaves the previous one even while the new one is still loading', () => {
    seedAccessibleSession({ authenticated: true })
    presenceState.self.set(sessionId, { presenceId: 'pres_self', leaveToken: 'leave-token' })
    const sessionResult = queryResponseMap.get(fnKey(api.paintingSessions.getSession))
    const otherSessionId = 'session_other' as Id<'paintingSessions'>
    // getSession for the new session hasn't resolved yet
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), (args: { sessionId: string }) =>
      args.sessionId === sessionId ? sessionResult : undefined
    )

    let editor: PaintingEditorContextValue | null = null
    function Harness({ id }: { id: Id<'paintingSessions'> }) {
      editor = usePaintingEditorController({ sessionId: id })
      return null
    }
    const { rerender, unmount } = mountTree(React.createElement(Harness, { id: sessionId }))
    expect(editor!.canEdit).toBe(true)

    rerender(React.createElement(Harness, { id: otherSessionId }))
    expect(editor!.sessionStatus).toBe('loading')
    expect(editor!.canEdit).toBe(false)
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(mutationArgs(api.presence.leaveSession)).toEqual([
      expect.objectContaining({ sessionId }),
    ])
    expect(mutationArgs(api.viewerAcks.removeViewerState)).toEqual([
      expect.objectContaining({ sessionId, viewerId: userId }),
    ])

    unmount()
  })

  test('edit-link collaborator: every editor query/mutation carries editKey as its own argument', async () => {
    seedAccessibleSession({ authenticated: true })
    setEditKey(sessionId, 'edit-secret')
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), {
      status: 'ok',
      canEdit: true,
      isOwner: false,
      session: {
        _id: sessionId,
        _creationTime: 1,
        name: 'Shared Painting',
        createdBy: 'someone_else' as Id<'users'>,
        hasGuestOwner: false,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 2,
      },
    })
    // Empty session: the editor must create the default layer with editKey
    queryResponseMap.set(fnKey(api.paintLayers.getPaintLayers), [])

    let editor: PaintingEditorContextValue | null = null
    function Harness() {
      editor = usePaintingEditorController({ sessionId })
      return null
    }
    const { unmount } = mountTree(React.createElement(Harness))

    expect(editor!.canEdit).toBe(true)
    expect(editor!.isOwner).toBe(false)
    expect(editor!.editKey).toBe('edit-secret')
    expect(editor!.guestKey).toBeUndefined()

    for (const ref of [
      api.paintingSessions.getSession,
      api.strokes.getSessionStrokes,
      api.presence.getSessionPresence,
      api.images.getSessionImages,
      api.paintLayers.getPaintLayers,
    ]) {
      expect(queryArgs.get(fnKey(ref))).toMatchObject({ sessionId, editKey: 'edit-secret' })
    }

    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toEqual([
      expect.objectContaining({ sessionId, editKey: 'edit-secret' }),
    ])
    expect(liveManagers()).toHaveLength(1)
    expect(liveManagers()[0].options.editKey).toBe('edit-secret')

    await act(async () => {
      await editor!.createPaintLayer('Layer 2')
      await editor!.updatePaintLayer({ layerId: 'paint_1' as Id<'paintLayers'>, opacity: 0.5 })
      await editor!.reorderLayer('paint_1', 1)
      await editor!.updateImageTransform('upload_1' as Id<'uploadedImages'>, { x: 5 })
      await editor!.updateAIImageTransform('ai_1' as Id<'aiGeneratedImages'>, { x: 6 })
      await editor!.addAIGeneratedImage({
        storageId: 'storage_ai' as Id<'_storage'>,
        width: 512,
        height: 512,
      })
      // Owner-only: a collaborator never sends the hard delete
      await editor!.deletePaintLayer('paint_1' as Id<'paintLayers'>)
    })

    for (const ref of [
      api.paintLayers.createPaintLayer,
      api.paintLayers.updatePaintLayer,
      api.layers.reorderLayer,
      api.images.updateImageTransform,
      api.images.updateAIImageTransform,
      api.images.addAIGeneratedImage,
    ]) {
      expect(mutationArgs(ref)).toEqual([expect.objectContaining({ editKey: 'edit-secret' })])
    }
    // storageId (AUD-010's blob binding) is passed through untouched
    expect(mutationArgs(api.images.addAIGeneratedImage)[0]).toMatchObject({
      sessionId,
      storageId: 'storage_ai',
    })
    expect(mutationArgs(api.paintLayers.deletePaintLayer)).toHaveLength(0)

    unmount()
  })

  test('read-only viewer: no P2P, no default-layer creation, no presence heartbeat, no writes', async () => {
    seedAccessibleSession({ authenticated: true })
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), {
      status: 'ok',
      canEdit: false,
      isOwner: false,
      session: {
        _id: sessionId,
        _creationTime: 1,
        name: 'Public Painting',
        createdBy: 'someone_else' as Id<'users'>,
        hasGuestOwner: false,
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 2,
      },
    })
    queryResponseMap.set(fnKey(api.paintLayers.getPaintLayers), [])

    let editor: PaintingEditorContextValue | null = null
    function Harness() {
      editor = usePaintingEditorController({ sessionId })
      return null
    }
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { unmount } = mountTree(React.createElement(Harness))

    expect(editor!.sessionReady).toBe(true)
    expect(editor!.canEdit).toBe(false)
    expect(p2pInstances).toHaveLength(0)
    expect(mutationArgs(api.paintLayers.ensureDefaultPaintLayer)).toHaveLength(0)
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20000)).toHaveLength(0)

    await act(async () => {
      expect(await editor!.createPaintLayer('Layer 2')).toBeUndefined()
      await editor!.reorderLayer('paint_1', 1)
      await editor!.updateUserPresence(1, 2, false, 'brush')
    })
    expect(mutationArgs(api.paintLayers.createPaintLayer)).toHaveLength(0)
    expect(mutationArgs(api.layers.reorderLayer)).toHaveLength(0)
    expect(presenceState.mutation).not.toHaveBeenCalled()

    unmount()
    setIntervalSpy.mockRestore()
  })

  test("a replaced P2PManager's late peer-disconnect or packet never touches the live manager's peers", () => {
    seedAccessibleSession({ authenticated: true })
    queryResponseMap.set(fnKey(api.presence.getSessionPresence), [peerPresenceRow('peer_42')])
    setEditKey(sessionId, 'edit-v1')

    let editor: PaintingEditorContextValue | null = null
    function Harness() {
      editor = usePaintingEditorController({ sessionId })
      return null
    }
    const { unmount } = mountTree(React.createElement(Harness))
    const first = liveManagers()[0]
    act(() => {
      first.options.onPeerConnected?.('peer_42')
    })
    expect(editor!.p2p.isConnected).toBe(true)

    // Rotating the edit key restarts P2P with a new manager
    act(() => {
      setEditKey(sessionId, 'edit-v2')
    })
    expect(first.destroy).toHaveBeenCalledTimes(1)
    const second = liveManagers()[0]
    expect(second).not.toBe(first)
    expect(second.options.editKey).toBe('edit-v2')
    act(() => {
      second.options.onPeerConnected?.('peer_42')
    })

    // The old manager's channel closes late, after it was destroyed
    act(() => {
      first.options.onPeerDisconnected?.('peer_42')
      first.options.onPacketReceived?.('peer_42', { t: 'cu', x: 0.5, y: 0.5, drawing: false })
    })
    expect(editor!.p2p.isConnected).toBe(true)
    expect(editor!.p2p.liveStore.cursors.get().size).toBe(0)

    // ...so sends still go out through the live manager
    act(() => {
      editor!.p2p.sendCursorPosition(0.1, 0.1, false)
    })
    expect(second.sendCursorPacket).toHaveBeenCalledTimes(1)

    // The live manager's own disconnect still works
    act(() => {
      second.options.onPeerDisconnected?.('peer_42')
    })
    expect(editor!.p2p.isConnected).toBe(false)

    unmount()
  })

  test('does not start presence heartbeat or P2P when session is unauthorized or not found', () => {
    queryResponseMap.set(fnKey(api.auth.getCurrentUser), {
      _id: userId,
      name: 'Alice',
      email: 'alice@example.com',
    })
    queryResponseMap.set(fnKey(api.paintingSessions.getSession), {
      status: 'unauthorized',
      session: null,
    })

    let snapshot: PaintingEditorContextValue | null = null
    function UnauthorizedHarness() {
      snapshot = usePaintingEditorController({ sessionId })
      return null
    }

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { unmount } = mountTree(React.createElement(UnauthorizedHarness))

    expect(snapshot!.sessionError).toBe('unauthorized')
    expect(snapshot!.validSessionId).toBeNull()
    expect(p2pInstances).toHaveLength(0)
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20000)).toHaveLength(0)

    unmount()
    act(() => {
      vi.advanceTimersByTime(0)
    })
    const leaveSessionMock = mutationMockMap.get(fnKey(api.presence.leaveSession))
    expect(leaveSessionMock).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })

  test('throws a helpful error if usePaintingEditor is called outside PaintingEditorProvider', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function OrphanConsumer() {
      usePaintingEditor()
      return null
    }

    expect(() => mountTree(React.createElement(OrphanConsumer))).toThrow(
      'usePaintingEditor must be used within a PaintingEditorProvider'
    )
    consoleErrorSpy.mockRestore()
  })
})
