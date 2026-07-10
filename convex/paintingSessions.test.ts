import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedSession(options: {
  ownerAuthId?: string
  guestOwnerKey?: string
  isPublic?: boolean
}) {
  const t = createTestBackend()
  let ownerId: Id<'users'> | undefined

  const sessionId = await t.run(async (ctx) => {
    if (options.ownerAuthId) {
      ownerId = await ctx.db.insert('users', {
        authId: options.ownerAuthId,
        email: `${options.ownerAuthId}@example.com`,
      })
    }

    return await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      guestOwnerKey: options.guestOwnerKey,
      isPublic: options.isPublic ?? false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })
  })

  return { t, sessionId }
}

describe('painting session thumbnails', () => {
  test('allows the signed-in owner to update a private session thumbnail', async () => {
    const ownerAuthId = 'thumbnail-owner'
    const { t, sessionId } = await seedSession({ ownerAuthId })

    await t.withIdentity({ subject: ownerAuthId }).mutation(
      api.paintingSessions.updateSessionThumbnail,
      { sessionId, thumbnailUrl: 'data:image/jpeg;base64,owner' },
    )

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.thumbnailUrl).toBe('data:image/jpeg;base64,owner')
  })

  test('rejects anonymous and non-owner writes to a private session thumbnail', async () => {
    const { t, sessionId } = await seedSession({ ownerAuthId: 'thumbnail-owner' })
    const args = { sessionId, thumbnailUrl: 'data:image/jpeg;base64,attacker' }

    await expect(
      t.mutation(api.paintingSessions.updateSessionThumbnail, args),
    ).rejects.toThrow('Unauthorized')

    await expect(
      t.withIdentity({ subject: 'thumbnail-outsider' }).mutation(
        api.paintingSessions.updateSessionThumbnail,
        args,
      ),
    ).rejects.toThrow('Unauthorized')

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.thumbnailUrl).toBeUndefined()
  })

  test('requires the matching key for a guest-owned private session', async () => {
    const guestOwnerKey = 'guest-thumbnail-key'
    const { t, sessionId } = await seedSession({ guestOwnerKey })
    const args = { sessionId, thumbnailUrl: 'data:image/jpeg;base64,guest' }

    await expect(
      t.mutation(api.paintingSessions.updateSessionThumbnail, {
        ...args,
        guestKey: 'wrong-key',
      }),
    ).rejects.toThrow('Unauthorized')

    await t.mutation(api.paintingSessions.updateSessionThumbnail, {
      ...args,
      guestKey: guestOwnerKey,
    })

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.thumbnailUrl).toBe('data:image/jpeg;base64,guest')
  })

  test('allows thumbnail updates for publicly editable sessions', async () => {
    const { t, sessionId } = await seedSession({ isPublic: true })

    await t.mutation(api.paintingSessions.updateSessionThumbnail, {
      sessionId,
      thumbnailUrl: 'data:image/jpeg;base64,public',
    })

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.thumbnailUrl).toBe('data:image/jpeg;base64,public')
  })
})
