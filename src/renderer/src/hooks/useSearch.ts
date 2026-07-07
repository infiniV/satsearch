import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Result } from '@shared/types'

type Query =
  | { kind: 'text'; query: string }
  | { kind: 'image'; imageBytes: ArrayBuffer }
  | { kind: 'ref'; ref: { sourceId: string; name: string } }

export type Ref = { sourceId: string; name: string }

export const SEARCH_PAGE = 200

export interface SearchApi {
  results: Result[]
  total: number | null
  belowWindow: boolean
  refTile: Ref | null
  scoreRange: [number, number]
  selected: Set<string>
  busy: boolean
  view: 'grid' | 'map'
  hasGeo: boolean
  hasRun: boolean
  labelState: Record<string, string>
  loadingMore: boolean
  hasMore: boolean
  searchDepthCap: number | null
  loadMore: () => void
  setScoreRange: (r: [number, number]) => void
  setView: (v: 'grid' | 'map') => void
  search: (opts: { query?: string; imageBytes?: ArrayBuffer }) => void
  findSimilar: (t: Ref) => void
  clearRef: () => void
  reRun: (range: [number, number], sel: Set<string>) => void
  toggleSource: (id: string) => void
  applyLabelLocal: (sourceId: string, name: string, label: string) => void
}

/** All search state + actions. Lives at the shell level because the Dashboard
 *  quick-search and the detail panel's "find similar" both drive it before
 *  navigating to the Search view. */
export function useSearch(): SearchApi {
  const [results, setResults] = useState<Result[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [belowWindow, setBelowWindow] = useState(false)
  const [refTile, setRefTile] = useState<Ref | null>(null)
  const [scoreRange, setScoreRange] = useState<[number, number]>([0, 1])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'grid' | 'map'>('grid')
  const [labelState, setLabelState] = useState<Record<string, string>>({})
  const [hasRun, setHasRun] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [searchDepthCap, setSearchDepthCap] = useState<number | null>(null)
  const reqId = useRef(0)
  const lastQuery = useRef<Query | null>(null)
  const hasGeo = results.some((r) => r.lat != null && r.lon != null)

  // backend keys "sid\0name" -> grid keys "sid name"
  const refreshLabelState = useCallback(async (rows: Result[]) => {
    if (!rows.length) return setLabelState({})
    const keys = rows.map((r) => [r.sourceId, r.name] as [string, string])
    const raw = await window.api.labelState(keys)
    const mapped: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) mapped[k.replace('\u0000', ' ')] = v
    setLabelState(mapped)
  }, [])

  // like refreshLabelState but merges (for appended pages) instead of replacing
  const mergeLabelState = useCallback(async (rows: Result[]) => {
    if (!rows.length) return
    const keys = rows.map((r) => [r.sourceId, r.name] as [string, string])
    const raw = await window.api.labelState(keys)
    const add: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) add[k.replace('\u0000', ' ')] = v
    setLabelState((s) => ({ ...s, ...add }))
  }, [])

  const runSearch = useCallback(
    async (q: Query, range: [number, number], sel: Set<string>) => {
      lastQuery.current = q
      const myReq = ++reqId.current
      setBusy(true)
      setHasRun(true)
      try {
        const base = {
          sources: sel.size ? [...sel] : undefined,
          minScore: range[0] > 0 ? range[0] : undefined,
          maxScore: range[1] < 1 ? range[1] : undefined,
          from: 0,
          limit: SEARCH_PAGE
        }
        const params =
          q.kind === 'text'
            ? { ...base, query: q.query }
            : q.kind === 'image'
              ? { ...base, imageBytes: q.imageBytes }
              : { ...base, ref: q.ref }
        const res = await window.api.search(params)
        if (myReq !== reqId.current) return
        setResults(res.results)
        setTotal(res.total)
        setBelowWindow(res.belowWindow)
        setSearchDepthCap(res.k)
        setHasMore(res.results.length === SEARCH_PAGE)
        refreshLabelState(res.results)
      } catch (e) {
        if (myReq === reqId.current) toast.error(String(e))
      } finally {
        if (myReq === reqId.current) setBusy(false)
      }
    },
    [refreshLabelState]
  )

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const q = lastQuery.current
    if (!q) return
    const myReq = reqId.current // a new search bumps this; bail if so
    setLoadingMore(true)
    try {
      const base = {
        sources: selected.size ? [...selected] : undefined,
        minScore: scoreRange[0] > 0 ? scoreRange[0] : undefined,
        maxScore: scoreRange[1] < 1 ? scoreRange[1] : undefined,
        from: results.length,
        limit: SEARCH_PAGE
      }
      const params =
        q.kind === 'text'
          ? { ...base, query: q.query }
          : q.kind === 'image'
            ? { ...base, imageBytes: q.imageBytes }
            : { ...base, ref: q.ref }
      const res = await window.api.search(params)
      if (myReq !== reqId.current) return
      setResults((prev) => [...prev, ...res.results])
      setHasMore(res.results.length === SEARCH_PAGE)
      mergeLabelState(res.results)
    } catch (e) {
      if (myReq === reqId.current) toast.error(String(e))
    } finally {
      if (myReq === reqId.current) setLoadingMore(false)
    }
  }, [loadingMore, hasMore, selected, scoreRange, results.length, mergeLabelState])

  const search = useCallback(
    (opts: { query?: string; imageBytes?: ArrayBuffer }) => {
      setRefTile(null)
      const q: Query = opts.imageBytes
        ? { kind: 'image', imageBytes: opts.imageBytes }
        : { kind: 'text', query: opts.query ?? '' }
      runSearch(q, scoreRange, selected)
    },
    [runSearch, scoreRange, selected]
  )

  const findSimilar = useCallback(
    (t: Ref) => {
      const ref = { sourceId: t.sourceId, name: t.name }
      setRefTile(ref)
      runSearch({ kind: 'ref', ref }, scoreRange, selected)
    },
    [runSearch, scoreRange, selected]
  )

  const reRun = useCallback(
    (range: [number, number], sel: Set<string>) => {
      if (lastQuery.current) runSearch(lastQuery.current, range, sel)
    },
    [runSearch]
  )

  const toggleSource = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        reRun(scoreRange, next)
        return next
      })
    },
    [reRun, scoreRange]
  )

  const applyLabelLocal = useCallback((sourceId: string, name: string, label: string) => {
    setLabelState((s) => ({ ...s, [`${sourceId} ${name}`]: label }))
  }, [])

  return {
    results,
    total,
    belowWindow,
    refTile,
    scoreRange,
    selected,
    busy,
    view,
    hasGeo,
    hasRun,
    labelState,
    loadingMore,
    hasMore,
    searchDepthCap,
    loadMore,
    setScoreRange,
    setView,
    search,
    findSimilar,
    clearRef: () => setRefTile(null),
    reRun,
    toggleSource,
    applyLabelLocal
  }
}
