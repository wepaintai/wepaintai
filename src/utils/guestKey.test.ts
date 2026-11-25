import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  consumeEditKeyFromWindowUrl,
  getEditKey,
  parseEditKeyFromUrl,
  removeEditKey,
  setEditKey,
  subscribeEditKeys,
} from './guestKey'

describe('parseEditKeyFromUrl', () => {
  test('extracts edit key from URL hash fragment and scrubs it', () => {
    expect(parseEditKeyFromUrl('?session=abc123', '#edit=secret_token_1')).toEqual({
      editKey: 'secret_token_1',
      cleanedSearch: '?session=abc123',
      cleanedHash: '',
      hadEditParam: true,
    })
  })

  test('preserves unrelated hash parameters when scrubbing #edit=', () => {
    expect(parseEditKeyFromUrl('?session=abc123', '#foo=1&edit=secret_2&bar=2')).toEqual({
      editKey: 'secret_2',
      cleanedSearch: '?session=abc123',
      cleanedHash: '#foo=1&bar=2',
      hadEditParam: true,
    })
  })

  test('gracefully accepts and scrubs ?edit= query parameter fallback', () => {
    expect(parseEditKeyFromUrl('?session=abc123&edit=query_secret', '')).toEqual({
      editKey: 'query_secret',
      cleanedSearch: '?session=abc123',
      cleanedHash: '',
      hadEditParam: true,
    })
  })

  test('prefers #edit= over ?edit= and scrubs both', () => {
    expect(parseEditKeyFromUrl('?session=abc123&edit=from_query', '#edit=from_hash')).toEqual({
      editKey: 'from_hash',
      cleanedSearch: '?session=abc123',
      cleanedHash: '',
      hadEditParam: true,
    })
  })

  test('leaves unrelated hash and search untouched when no edit token is present', () => {
    expect(parseEditKeyFromUrl('?session=abc123', '#canvas-anchor')).toEqual({
      editKey: null,
      cleanedSearch: '?session=abc123',
      cleanedHash: '#canvas-anchor',
      hadEditParam: false,
    })
  })

  test('scrubs empty edit= parameter without returning an empty key', () => {
    expect(parseEditKeyFromUrl('?session=abc123', '#edit=')).toEqual({
      editKey: null,
      cleanedSearch: '?session=abc123',
      cleanedHash: '',
      hadEditParam: true,
    })
  })
})

describe('editKey storage and URL consumption', () => {
  afterEach(() => {
    removeEditKey('sess-1')
    removeEditKey('sess-2')
    vi.unstubAllGlobals()
  })

  test('stores, retrieves, notifies subscribers, and removes edit keys', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEditKeys(listener)

    expect(getEditKey('sess-1')).toBeNull()
    setEditKey('sess-1', 'tok-abc')
    expect(getEditKey('sess-1')).toBe('tok-abc')
    expect(listener).toHaveBeenCalledTimes(1)

    removeEditKey('sess-1')
    expect(getEditKey('sess-1')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  test('consumeEditKeyFromWindowUrl persists to sessionStorage and scrubs URL via history.replaceState', () => {
    const storageMap = new Map<string, string>()
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: {
        pathname: '/',
        search: '?session=sess-2',
        hash: '#edit=secret-from-hash',
      },
      history: {
        state: { idx: 0 },
        replaceState,
      },
      sessionStorage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => storageMap.set(k, v),
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    })

    const key = consumeEditKeyFromWindowUrl('sess-2')
    expect(key).toBe('secret-from-hash')
    expect(getEditKey('sess-2')).toBe('secret-from-hash')
    expect(replaceState).toHaveBeenCalledWith({ idx: 0 }, '', '/?session=sess-2')
  })
})
