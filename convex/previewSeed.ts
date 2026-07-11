import { internalMutation } from './_generated/server'

const SEED_SESSION_NAME = 'Preview: collaborative sunset'

/** Seed a small, representative dataset in a newly allocated preview slot. */
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.PREVIEW_DEPLOYMENT !== 'true') {
      throw new Error('Preview seed refused outside a preview deployment')
    }

    const existing = await ctx.db
      .query('paintingSessions')
      .filter((q) => q.eq(q.field('name'), SEED_SESSION_NAME))
      .first()
    if (existing) {
      return { created: false, sessionId: existing._id }
    }

    const now = Date.now()
    const userId = await ctx.db.insert('users', {
      authId: 'preview-seed-user',
      name: 'Preview Artist',
      email: 'preview-artist@example.invalid',
      tokens: 125,
      lifetimeTokensUsed: 10,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.insert('tokenTransactions', {
      userId,
      type: 'initial',
      amount: 125,
      balance: 125,
      description: 'Preview seed balance',
      createdAt: now,
    })

    const sessionId = await ctx.db.insert('paintingSessions', {
      name: SEED_SESSION_NAME,
      createdBy: userId,
      isPublic: true,
      canvasWidth: 1024,
      canvasHeight: 768,
      strokeCounter: 3,
      paintLayerOrder: 0,
      paintLayerVisible: true,
      lastModified: now,
      recentStrokeOrders: [1, 2, 3],
      aiPrompts: ['warm sunset over rolling hills'],
    })

    const layerId = await ctx.db.insert('paintLayers', {
      sessionId,
      name: 'Sunset sketch',
      layerOrder: 0,
      visible: true,
      opacity: 1,
      createdBy: userId,
      createdAt: now,
    })

    const strokes = [
      {
        points: [
          { x: 80, y: 560 },
          { x: 300, y: 430 },
          { x: 520, y: 545 },
        ],
        brushColor: '#7c3aed',
        brushSize: 24,
      },
      {
        points: [
          { x: 430, y: 250 },
          { x: 510, y: 220 },
          { x: 590, y: 250 },
        ],
        brushColor: '#fb923c',
        brushSize: 42,
      },
      {
        points: [
          { x: 20, y: 620 },
          { x: 400, y: 590 },
          { x: 980, y: 630 },
        ],
        brushColor: '#14532d',
        brushSize: 36,
      },
    ]

    const strokeIds = []
    for (const [index, stroke] of strokes.entries()) {
      strokeIds.push(
        await ctx.db.insert('strokes', {
          sessionId,
          layerId,
          userId,
          userColor: '#7c3aed',
          points: stroke.points,
          brushColor: stroke.brushColor,
          brushSize: stroke.brushSize,
          opacity: 1,
          strokeOrder: index + 1,
          colorMode: 'solid',
        }),
      )
    }

    await ctx.db.patch(sessionId, { recentStrokeIds: strokeIds })
    return { created: true, sessionId }
  },
})
