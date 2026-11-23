import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'
import { modules } from './test.setup'

const OWNER = 'presence-owner'
const OTHER = 'presence-other'
// Public sessions are read-only; collaborators edit (and show presence) via the edit link
const EDIT_KEY = 'presence-edit-key'

async function seed() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', { authId: OWNER, email: 'o@example.com' })
    const otherId = await ctx.db.insert('users', { authId: OTHER, email: 'x@example.com' })
    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      isPublic: true,
      editKey: EDIT_KEY,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })
    return { ownerId, otherId, sessionId }
  })
  return {
    t,
    ...ids,
    asOwner: t.withIdentity({ subject: OWNER }),
    asOther: t.withIdentity({ subject: OTHER }),
  }
}

const presenceArgs = (name: string) => ({
  userColor: '#123456',
  userName: name,
  cursorX: 1,
  cursorY: 2,
  isDrawing: false,
  currentTool: 'brush',
})

const liveStrokeArgs = {
  userColor: '#123456',
  userName: 'drawer',
  points: [{ x: 1, y: 1 }],
  brushColor: '#000',
  brushSize: 4,
  opacity: 1,
}

async function beacon(t: ReturnType<typeof convexTest>, body: unknown) {
  const response = await t.fetch('/presence/leave', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  expect(response.status).toBe(200)
}

async function counts(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    presence: (await ctx.db.query('userPresence').collect()).length,
    live: (await ctx.db.query('liveStrokes').collect()).length,
  }))
}

// t.fetch loads the HTTP router (including the Better Auth component) on first
// use, which can exceed vitest's 5 s default on a loaded machine.
describe('POST /presence/leave (sendBeacon) authentication', { timeout: 30_000 }, () => {
  test('requires the leave token issued to that presence row', async () => {
    const { t, sessionId, ownerId, asOwner, asOther } = await seed()

    const owner = await asOwner.mutation(api.presence.updatePresence, {
      sessionId,
      ...presenceArgs('Owner'),
    })
    await asOwner.mutation(api.liveStrokes.updateLiveStroke, { sessionId, ...liveStrokeArgs })
    const other = await asOther.mutation(api.presence.updatePresence, {
      sessionId,
      editKey: EDIT_KEY,
      ...presenceArgs('Other'),
    })
    expect(owner && other).toBeTruthy()
    expect(await counts(t)).toEqual({ presence: 2, live: 1 })

    // Old unauthenticated payload shape ({userId, guestId}) is ignored
    await beacon(t, { sessionId, userId: ownerId })
    // Wrong token, another user's token, cross-session, and junk are ignored
    await beacon(t, { sessionId, presenceId: owner!.presenceId, leaveToken: 'f'.repeat(48) })
    await beacon(t, { sessionId, presenceId: owner!.presenceId, leaveToken: other!.leaveToken })
    await beacon(t, { sessionId: 'not-an-id', presenceId: owner!.presenceId, leaveToken: owner!.leaveToken })
    await beacon(t, 'not json')
    expect(await counts(t)).toEqual({ presence: 2, live: 1 })

    // The owner's own token removes exactly the owner's presence and live stroke
    await beacon(t, { sessionId, presenceId: owner!.presenceId, leaveToken: owner!.leaveToken })
    expect(await counts(t)).toEqual({ presence: 1, live: 0 })
    const remaining = await asOther.query(api.presence.getSessionPresence, { sessionId })
    expect(remaining.map((p) => p.userName)).toEqual(['Other'])
  })

  test('the leave token survives presence updates (replace keeps it)', async () => {
    const { t, sessionId, asOwner } = await seed()
    const first = await asOwner.mutation(api.presence.updatePresence, {
      sessionId,
      ...presenceArgs('Owner'),
    })
    const second = await asOwner.mutation(api.presence.updatePresence, {
      sessionId,
      ...presenceArgs('Owner'),
      cursorX: 500,
    })
    expect(second).toEqual(first)
    await beacon(t, { sessionId, presenceId: first!.presenceId, leaveToken: first!.leaveToken })
    expect((await counts(t)).presence).toBe(0)
  })
})

describe('guest identity is not exposed to other clients', () => {
  test('presence and live strokes never return guestId or leave tokens', async () => {
    const { t, sessionId, asOther } = await seed()
    const guestId = 'guest-browser-secret-id'

    await t.mutation(api.presence.updatePresence, {
      sessionId,
      guestId,
      editKey: EDIT_KEY,
      ...presenceArgs('Guest'),
    })
    await t.mutation(api.liveStrokes.updateLiveStroke, {
      sessionId,
      guestId,
      editKey: EDIT_KEY,
      ...liveStrokeArgs,
    })

    const presence = await asOther.query(api.presence.getSessionPresence, { sessionId })
    const live = await asOther.query(api.liveStrokes.getLiveStrokes, { sessionId })
    expect(presence).toHaveLength(1)
    expect(live).toHaveLength(1)
    const serialized = JSON.stringify([presence, live])
    expect(serialized).not.toContain(guestId)
    expect(presence[0]).not.toHaveProperty('guestId')
    expect(presence[0]).not.toHaveProperty('leaveToken')
    expect(live[0]).not.toHaveProperty('guestId')

    // The public presence _id is not proof of identity: it cannot be used as a
    // guestId to evict or overwrite the guest, and the beacon needs the token.
    const publicId = presence[0]._id
    await t.mutation(api.presence.leaveSession, { sessionId, guestId: publicId, editKey: EDIT_KEY })
    await t.mutation(api.liveStrokes.clearLiveStroke, {
      sessionId,
      guestId: publicId,
      editKey: EDIT_KEY,
    })
    await beacon(t, { sessionId, presenceId: publicId, leaveToken: publicId })
    expect(await counts(t)).toEqual({ presence: 1, live: 1 })
  })
})
