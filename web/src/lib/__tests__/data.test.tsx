import { describe, expect, it, afterEach, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import {
  DATA_VERSIONS,
  DEFAULT_DATA_VERSION,
  getDataVersion,
  loadSpriteOverrides,
  resolveInitialVersion,
  setDataVersion,
  setSpriteOverrides,
  spriteUrl,
} from '../data'
import { GameDataProvider, useGameDataVersion } from '../GameDataContext'
import { Header } from '../../App'

describe('data version management', () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch

  function setupMockWindow(search: string = '', storedVersion?: string) {
    const store = new Map<string, string>()
    if (storedVersion !== undefined) {
      store.set('er-data-version', storedVersion)
    }
    const replaceStateMock = vi.fn()
    const mockWin = {
      location: {
        search,
        pathname: '/',
        hash: '',
      },
      history: {
        replaceState: replaceStateMock,
      },
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, val: string) => {
          store.set(key, val)
        }),
        removeItem: vi.fn((key: string) => {
          store.delete(key)
        }),
      },
    } as unknown as Window & typeof globalThis
    globalThis.window = mockWin
    return { mockWin, replaceStateMock, store }
  }

  afterEach(() => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
    setDataVersion(DEFAULT_DATA_VERSION)
  })

  describe('version resolution', () => {
    it('defaults to v2.65.5 when neither URL query nor localStorage is set', () => {
      setupMockWindow('', undefined)
      expect(resolveInitialVersion()).toBe('v2.65.5')
    })

    it('resolves directly supported versions from ?v=', () => {
      setupMockWindow('?v=v2.65.5')
      expect(resolveInitialVersion()).toBe('v2.65.5')

      setupMockWindow('?v=v2.65.4.1b')
      expect(resolveInitialVersion()).toBe('v2.65.4.1b')

      setupMockWindow('?v=v2.65beta')
      expect(resolveInitialVersion()).toBe('v2.65beta')
    })

    it('resolves the v2.65.3b alias from ?v= to v2.65beta', () => {
      setupMockWindow('?v=v2.65.3b')
      expect(resolveInitialVersion()).toBe('v2.65beta')
    })

    it('falls back to localStorage if ?v= is absent', () => {
      setupMockWindow('', 'v2.65.4.1b')
      expect(resolveInitialVersion()).toBe('v2.65.4.1b')

      setupMockWindow('', 'v2.65.3b')
      expect(resolveInitialVersion()).toBe('v2.65beta')
    })

    it('ignores unknown versions in query or localStorage and falls back to default', () => {
      setupMockWindow('?v=invalid-version', 'another-invalid')
      expect(resolveInitialVersion()).toBe(DEFAULT_DATA_VERSION)
    })

    it('prioritizes ?v= query parameter over localStorage', () => {
      setupMockWindow('?v=v2.65.4.1b', 'v2.65.5')
      expect(resolveInitialVersion()).toBe('v2.65.4.1b')
    })
  })

  describe('getDataVersion and setDataVersion', () => {
    it('updates currentVersion and stores to localStorage', () => {
      const { store } = setupMockWindow()
      setDataVersion('v2.65.4.1b')
      expect(getDataVersion()).toBe('v2.65.4.1b')
      expect(store.get('er-data-version')).toBe('v2.65.4.1b')
    })
  })

  describe('spriteUrl and sprite overrides', () => {
    it('returns v2.65.5 path for base version regardless of overrides', () => {
      expect(spriteUrl('SPECIES_PIKACHU', 'front', 'v2.65.5')).toBe(
        '/data/v2.65.5/sprites/SPECIES_PIKACHU/front.png',
      )
      expect(spriteUrl('SPECIES_PIKACHU', 'icon', 'v2.65.5')).toBe(
        '/data/v2.65.5/sprites/SPECIES_PIKACHU/icon.png',
      )
    })

    it('falls back to v2.65.5 sprites for older versions when not overridden', () => {
      setSpriteOverrides('v2.65.4.1b', [])
      expect(spriteUrl('SPECIES_CHARIZARD', 'back', 'v2.65.4.1b')).toBe(
        '/data/v2.65.5/sprites/SPECIES_CHARIZARD/back.png',
      )
    })

    it('returns version-specific sprite path when sprite is registered in overrides', () => {
      setSpriteOverrides('v2.65.4.1b', ['SPECIES_AEGISLASH/front', 'SPECIES_AEGISLASH/icon'])
      expect(spriteUrl('SPECIES_AEGISLASH', 'front', 'v2.65.4.1b')).toBe(
        '/data/v2.65.4.1b/sprites/SPECIES_AEGISLASH/front.png',
      )
      expect(spriteUrl('SPECIES_AEGISLASH', 'icon', 'v2.65.4.1b')).toBe(
        '/data/v2.65.4.1b/sprites/SPECIES_AEGISLASH/icon.png',
      )
      // Un-overridden variant on same species falls back to base
      expect(spriteUrl('SPECIES_AEGISLASH', 'back', 'v2.65.4.1b')).toBe(
        '/data/v2.65.5/sprites/SPECIES_AEGISLASH/back.png',
      )
    })

    it('uses currentVersion by default', () => {
      setDataVersion('v2.65beta')
      setSpriteOverrides('v2.65beta', ['SPECIES_MEWTWO/front'])
      expect(spriteUrl('SPECIES_MEWTWO', 'front')).toBe(
        '/data/v2.65beta/sprites/SPECIES_MEWTWO/front.png',
      )
      expect(spriteUrl('SPECIES_MEWTWO', 'back')).toBe(
        '/data/v2.65.5/sprites/SPECIES_MEWTWO/back.png',
      )
    })
  })

  describe('loadSpriteOverrides', () => {
    it('returns parsed string array on ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ['SPECIES_A/front', 'SPECIES_B/icon'],
      } as unknown as Response)

      const result = await loadSpriteOverrides('v2.65.4.1b')
      expect(result).toEqual(['SPECIES_A/front', 'SPECIES_B/icon'])
    })

    it('returns empty array on fetch failure or error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response)

      const result = await loadSpriteOverrides('v2.65.5')
      expect(result).toEqual([])

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'))
      const errorResult = await loadSpriteOverrides('v2.65beta')
      expect(errorResult).toEqual([])
    })
  })

  describe('Header component and version switching', () => {
    it('renders version select dropdown with all DATA_VERSIONS options', () => {
      setupMockWindow()
      const html = renderToString(
        <MemoryRouter>
          <GameDataProvider>
            <Header />
          </GameDataProvider>
        </MemoryRouter>,
      )

      expect(html).toContain('aria-label="Game version"')
      for (const v of DATA_VERSIONS) {
        expect(html).toContain(`value="${v.id}"`)
        expect(html).toContain(v.label)
      }
    })

    it('GameDataProvider exposes version and setVersion', () => {
      const { replaceStateMock } = setupMockWindow('?v=v2.65.5')

      const captured = {
        version: '',
        setVersion: null as ((v: any) => void) | null,
      }

      function TestConsumer() {
        const { version, setVersion } = useGameDataVersion()
        captured.version = version
        captured.setVersion = setVersion
        return null
      }

      renderToString(
        <GameDataProvider>
          <TestConsumer />
        </GameDataProvider>,
      )

      expect(captured.version).toBe('v2.65.5')
      expect(captured.setVersion).toBeInstanceOf(Function)

      // Test invoking setVersion updates state & replaceState if ?v= present
      captured.setVersion!('v2.65.4.1b')
      expect(getDataVersion()).toBe('v2.65.4.1b')
      expect(replaceStateMock).toHaveBeenCalledWith(null, '', '/?v=v2.65.4.1b')
    })
  })
})
