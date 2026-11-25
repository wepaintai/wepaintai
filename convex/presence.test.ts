import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'
import { modules } from './test.setup'

const OWNER = 'presence-owner'
const OTHER = 'presence-other'

async function seed() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', { authId: OWNER, email: 'o@example.com' })
    const otherId = await ctx.db.insert('users', { authId: OTHER, email: 'x@example.com' })
    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      isPublic: true,
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

describe('POST /presence/leave (sendBeacon) authentication', () => {
  test('requires the leave token issued to that presence row', async () => {
    const { t, sessionId, ownerId, asOwner, asOther } = await seed()

    const owner = await asOwner.mutation(api.presence.updatePresence, {
      sessionId,
      ...presenceArgs('Owner'),
    })
    await asOwner.mutation(api.liveStrokes.updateLiveStroke, { sessionId, ...liveStrokeArgs })
    const other = await asOther.mutation(api.presence.updatePresence, {
      sessionId,
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
