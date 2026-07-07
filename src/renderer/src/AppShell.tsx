import { useCallback, useEffect, useRef, useState } from 'react'
import type { DetailTile } from '@shared/types'
import { useHealth } from './hooks/useHealth'
import { useSources } from './hooks/useSources'
import { useJobs } from './hooks/useJobs'
import { useClasses } from './hooks/useClasses'
import { useSearch } from './hooks/useSearch'
import { HealthGate } from './components/HealthGate'
import { Rail, type Route } from './components/Rail'
import { DetailPanel } from './components/DetailPanel'
import { StatsBar } from './components/StatsBar'
import { Dashboard } from './views/Dashboard'
import { SearchView } from './views/SearchView'
import { GalleryView } from './views/GalleryView'
import { LabelsView } from './views/LabelsView'
import { SourcesView } from './views/SourcesView'
import { SettingsView } from './views/SettingsView'

export function AppShell(): React.JSX.Element {
  const { health, error, boot, logs, readyTick, retry } = useHealth()
  const { sources, refresh: refreshSources } = useSources(readyTick)
  const jobs = useJobs()
  const { classes, refresh: refreshClasses } = useClasses()
  const search = useSearch()

  const [route, setRoute] = useState<Route>('dashboard')
  const [activeClass, setActiveClass] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailTile | null>(null)
  const [gallerySource, setGallerySource] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // reload label counts when the sidecar comes up
  useEffect(() => {
    if (readyTick) refreshClasses()
  }, [readyTick, refreshClasses])

  const openDetail = useCallback((t: DetailTile) => setDetail(t), [])

  // tag a tile with the active class (Search / Gallery / Detail share this)
  const applyLabel = useCallback(
    async (t: DetailTile) => {
      if (!activeClass) return
      await window.api.setLabel(t.sourceId, t.name, activeClass)
      search.applyLabelLocal(t.sourceId, t.name, activeClass)
      refreshClasses()
    },
    [activeClass, search, refreshClasses]
  )

  const runQuickSearch = useCallback(
    (q: string) => {
      search.search({ query: q })
      setRoute('search')
    },
    [search]
  )

  const findSimilar = useCallback(
    (t: DetailTile) => {
      search.findSimilar({ sourceId: t.sourceId, name: t.name })
      setRoute('search')
      setDetail(null)
    },
    [search]
  )

  const browseSource = useCallback((sourceId: string) => {
    setGallerySource(sourceId)
    setRoute('gallery')
  }, [])

  // global keys: '/' focuses search (jumping to the Search view), Esc closes detail
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && detail) {
        setDetail(null)
        return
      }
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      if (e.key === '/' && !typing && !detail) {
        e.preventDefault()
        setRoute('search')
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <HealthGate health={health} error={error} boot={boot} logs={logs} onRetry={retry} />

      <Rail
        route={route}
        onNavigate={setRoute}
        health={health}
        badges={{ sources: sources.length, labels: classes.length || undefined }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-hidden">
          {route === 'dashboard' && (
            <Dashboard
              health={health}
              sources={sources}
              jobs={jobs}
              classes={classes}
              onQuickSearch={runQuickSearch}
              onOpenSource={browseSource}
            />
          )}
          {route === 'search' && (
            <SearchView
              search={search}
              sources={sources}
              jobs={jobs}
              activeClass={activeClass}
              onOpen={openDetail}
              onLabel={applyLabel}
              searchInputRef={searchInputRef}
            />
          )}
          {route === 'gallery' && (
            <GalleryView
              key={gallerySource ?? 'gallery'}
              sources={sources}
              activeClass={activeClass}
              initialSource={gallerySource}
              onOpen={openDetail}
              onFindSimilar={findSimilar}
              onLabel={applyLabel}
            />
          )}
          {route === 'labels' && (
            <LabelsView
              classes={classes}
              activeClass={activeClass}
              onSetActive={setActiveClass}
              onClassesChanged={refreshClasses}
            />
          )}
          {route === 'sources' && (
            <SourcesView sources={sources} onChanged={refreshSources} onBrowse={browseSource} />
          )}
          {route === 'settings' && <SettingsView readyTick={readyTick} />}
        </main>

        <StatsBar
          health={health}
          sources={sources}
          total={route === 'search' ? search.total : null}
        />
      </div>

      <DetailPanel
        tile={detail}
        sources={sources}
        activeClass={activeClass}
        onClose={() => setDetail(null)}
        onFindSimilar={findSimilar}
        onOpenTile={openDetail}
        onLabel={applyLabel}
      />
    </div>
  )
}
