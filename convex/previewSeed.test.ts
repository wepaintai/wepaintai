import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { internal } from './_generated/api'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

afterEach(() => {
  vi.unstubAllEnvs()
})
describe('preview seed', () => {
  test('refuses to seed a non-preview deployment', async () => {
    vi.stubEnv('PREVIEW_DEPLOYMENT', '')
    const t = createTestBackend()

    await expect(t.mutation(internal.previewSeed.seed, {})).rejects.toThrow(
      'Preview seed refused outside a preview deployment',
    )
  })

  test('creates representative data once and is idempotent', async () => {
    vi.stubEnv('PREVIEW_DEPLOYMENT', 'true')
    const t = createTestBackend()

    const first = await t.mutation(internal.previewSeed.seed, {})
    const second = await t.mutation(internal.previewSeed.seed, {})

    expect(first.created).toBe(true)
    expect(second).toEqual({ created: false, sessionId: first.sessionId })

    const counts = await t.run(async (ctx) => ({
      users: (await ctx.db.query('users').collect()).length,
      sessions: (await ctx.db.query('paintingSessions').collect()).length,
      layers: (await ctx.db.query('paintLayers').collect()).length,
      strokes: (await ctx.db.query('strokes').collect()).length,
      transactions: (await ctx.db.query('tokenTransactions').collect()).length,
    }))
    expect(counts).toEqual({
      users: 1,
      sessions: 1,
      layers: 1,
      strokes: 3,
      transactions: 1,
    })
  })
})
