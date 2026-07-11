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

describe('getUserSessions', () => {
  test('returns only owned sessions and excludes every contribution source', async () => {
    const t = createTestBackend()
    const authId = 'library-owner'

    await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        authId,
        email: `${authId}@example.com`,
      })
      const otherUserId = await ctx.db.insert('users', {
        authId: 'other-owner',
        email: 'other-owner@example.com',
      })

      await ctx.db.insert('paintingSessions', {
        name: 'Owned canvas',
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
        lastModified: 100,
      })
      const publicStrokeSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Contributed public stroke canvas',
        createdBy: otherUserId,
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 1,
      })
      const privateUploadSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Contributed private upload canvas',
        createdBy: otherUserId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      const publicLayerSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Contributed public layer canvas',
        createdBy: otherUserId,
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })

      await ctx.db.insert('strokes', {
        sessionId: publicStrokeSessionId,
        userId,
        userColor: '#000000',
        points: [{ x: 0, y: 0 }],
        brushColor: '#000000',
        brushSize: 5,
        opacity: 1,
        strokeOrder: 1,
      })

      const storageId = await ctx.storage.store(new Blob(['image']))
      await ctx.db.insert('uploadedImages', {
        sessionId: privateUploadSessionId,
        userId,
        storageId,
        filename: 'contribution.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 0,
      })

      await ctx.db.insert('paintLayers', {
        sessionId: publicLayerSessionId,
        name: 'Contributed layer',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdBy: userId,
        createdAt: Date.now(),
      })
    })

    const sessions = await t.withIdentity({ subject: authId }).query(
      api.paintingSessions.getUserSessions,
      {},
    )

    expect(sessions.map((session) => session.name)).toEqual(['Owned canvas'])
  })

  test('sorts owned sessions by lastModified descending', async () => {
    const t = createTestBackend()
    const authId = 'sorted-library-owner'

    await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        authId,
        email: `${authId}@example.com`,
      })

      for (const [name, lastModified] of [
        ['Old canvas', 100],
        ['Newest canvas', 300],
        ['Middle canvas', 200],
      ] as const) {
        await ctx.db.insert('paintingSessions', {
          name,
          createdBy: userId,
          isPublic: false,
          canvasWidth: 800,
          canvasHeight: 600,
          strokeCounter: 0,
          lastModified,
        })
      }

      await ctx.db.insert('paintingSessions', {
        name: 'Deleted canvas',
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
        lastModified: 400,
        deletedAt: Date.now(),
      })
    })

    const sessions = await t.withIdentity({ subject: authId }).query(
      api.paintingSessions.getUserSessions,
      {},
    )

    expect(sessions.map((session) => session.name)).toEqual([
      'Newest canvas',
      'Middle canvas',
      'Old canvas',
    ])
  })
})
