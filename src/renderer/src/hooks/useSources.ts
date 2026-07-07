import { useCallback, useEffect, useState } from 'react'
import type { Source } from '@shared/types'

/** The source registry, refreshed on mount, on sidecar-ready, and on mutation events. */
export function useSources(readyTick: number): {
  sources: Source[]
  refresh: () => Promise<void>
} {
  const [sources, setSources] = useState<Source[]>([])

  const refresh = useCallback(async () => {
    try {
      setSources(await window.api.listSources())
    } catch {
      /* sidecar not ready yet — a later readyTick / event will retry */
    }
  }, [])

  useEffect(() => {
    refresh()
    const off = window.api.onSourcesChanged(refresh)
    return off
  }, [refresh, readyTick])

  return { sources, refresh }
}
