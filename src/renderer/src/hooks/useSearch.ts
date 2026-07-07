import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Result } from '@shared/types'

type Query =
  | { kind: 'text'; query: string }
  | { kind: 'image'; imageBytes: ArrayBuffer }
  | { kind: 'ref'; ref: { sourceId: string; name: string } }

export type Ref = { sourceId: string; name: string }

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

  const runSearch = useCallback(
    async (q: Query, range: [number, number], sel: Set<string>) => {
      lastQuery.current = q
      setBusy(true)
      setHasRun(true)
      try {
        const base = {
          sources: sel.size ? [...sel] : undefined,
          minScore: range[0] > 0 ? range[0] : undefined,
          maxScore: range[1] < 1 ? range[1] : undefined,
          limit: 200
        }
        const params =
          q.kind === 'text'
            ? { ...base, query: q.query }
            : q.kind === 'image'
              ? { ...base, imageBytes: q.imageBytes }
              : { ...base, ref: q.ref }
        const res = await window.api.search(params)
        setResults(res.results)
        setTotal(res.total)
        setBelowWindow(res.belowWindow)
        refreshLabelState(res.results)
      } catch (e) {
        toast.error(String(e))
      } finally {
        setBusy(false)
      }
    },
    [refreshLabelState]
  )

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
