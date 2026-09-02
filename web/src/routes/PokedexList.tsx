import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useGameData } from '../lib/GameDataContext'
import FilterPills from '../features/pokedex/FilterPills'
import FilterRail from '../features/pokedex/FilterRail'
import { applyFilters, filtersFromSearchParams, filtersToSearchParams, isEmpty } from '../features/pokedex/filters'
import SpeciesListView, { type SpeciesListHandle } from '../features/pokedex/SpeciesListView'
import { buildSearchIndex, searchSpecies } from '../features/pokedex/search'

export default function PokedexList() {
  const { species } = useGameData()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false)
  const [filtersVisible, setFiltersVisible] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<SpeciesListHandle>(null)

  const setFilters = useCallback(
    (next: typeof filters) => {
      const params = filtersToSearchParams(next, searchParams)
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  useEffect(() => {
    const params = new URLSearchParams(searchParams)
    if (query) params.set('q', query)
    else params.delete('q')
    if (params.toString() !== searchParams.toString()) setSearchParams(params, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // 777 of 1907 entries are forms (e.g. every mega/regional/battle form) -- listing
  // them as peers would flood the list with duplicate names. The primary list shows
  // base species only; forms are reachable from the base species' detail view.
  const baseSpecies = useMemo(() => species.filter((s) => !s.isForm), [species])
  const searchIndex = useMemo(() => buildSearchIndex(baseSpecies, species), [baseSpecies, species])

  const results = useMemo(() => {
    const searched = searchSpecies(searchIndex, query)
    return applyFilters(searched, filters)
  }, [searchIndex, query, filters])

  // Autofocus on load, and re-focus whenever anyone starts typing without having
  // clicked into the box first.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
    listRef.current?.scrollToIndex(0)
  }, [query, filters])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const isTypingElsewhere =
        target !== inputRef.current && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      if (isTypingElsewhere) return

      if (e.key === '/' && target !== inputRef.current) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (target !== inputRef.current && /^[a-zA-Z0-9]$/.test(e.key)) {
        inputRef.current?.focus() // let the keypress itself land in the now-focused input
      }
      if (e.key === 'Escape') {
        if (query) {
          setQuery('')
        } else {
          inputRef.current?.blur()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => {
          const next = Math.min(i + 1, results.length - 1)
          listRef.current?.scrollToIndex(next)
          return next
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => {
          const next = Math.max(i - 1, 0)
          listRef.current?.scrollToIndex(next)
          return next
        })
        return
      }
      if (e.key === 'Enter') {
        const chosen = results[selectedIndex]
        if (chosen) navigate(`/pokemon/${chosen.id}`)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [query, results, selectedIndex, navigate])

  return (
    <div className="h-full flex">
      {filtersVisible && (
        <div className="hidden md:block">
          <FilterRail filters={filters} onChange={setFilters} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col md:border-l" style={{ borderColor: 'var(--color-border)' }}>
        <div
          className="px-3 py-2 shrink-0 flex items-center gap-2 sticky top-0 z-10"
          style={{ background: 'var(--color-bg)' }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name… (press / to focus)"
            className="flex-1 min-w-0 rounded-md border px-3 py-1.5 text-sm outline-none"
            style={{
              background: 'var(--color-bg-elevated)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text)',
            }}
          />
          <button
            type="button"
            onClick={() => setFiltersSheetOpen(true)}
            className="md:hidden shrink-0 rounded-md border px-2 py-1.5 text-sm relative"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            Filters
            {!isEmpty(filters) && (
              <span
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full"
                style={{ background: 'var(--color-accent)' }}
              />
            )}
          </button>
          <button
            type="button"
            onClick={() => setFiltersVisible((v) => !v)}
            className="hidden md:inline-flex shrink-0 rounded-md border px-2 py-1.5 text-sm relative"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            {filtersVisible ? 'Hide filters' : 'Show filters'}
            {!filtersVisible && !isEmpty(filters) && (
              <span
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full"
                style={{ background: 'var(--color-accent)' }}
              />
            )}
          </button>
          <span className="hidden sm:inline-block text-sm shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {results.length} of {baseSpecies.length}
          </span>
        </div>
        {!isEmpty(filters) && <FilterPills filters={filters} onChange={setFilters} />}
        <div className="flex-1 min-h-0">
          {results.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No matches{query ? ` for "${query}"` : ''} — try relaxing a filter
              {query ? ' or a shorter name' : ''}.
            </div>
          ) : (
            <SpeciesListView ref={listRef} species={results} selectedIndex={selectedIndex} />
          )}
        </div>
      </div>

      {filtersSheetOpen && (
        <div className="md:hidden fixed inset-0 z-20 flex flex-col justify-end">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setFiltersSheetOpen(false)}
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.5)' }}
          />
          <div
            className="relative rounded-t-xl max-h-[80vh] flex flex-col"
            style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)' }}
          >
            <div
              className="flex items-center justify-between px-3 py-2 border-b shrink-0"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <span className="font-semibold text-sm">Filters</span>
              <button
                type="button"
                onClick={() => setFiltersSheetOpen(false)}
                className="text-sm underline"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Done
              </button>
            </div>
            <FilterRail filters={filters} onChange={setFilters} className="w-full" />
          </div>
        </div>
      )}
    </div>
  )
}
