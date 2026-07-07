import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowseResponse,
  HealthStatus,
  ImportPreview,
  Job,
  SearchResponse,
  SettingsInfo,
  Source,
  SearchParams,
  SidecarProgress,
  TileMeta,
  TileSort
} from '@shared/types'

type JobsSnapshot = { jobs: Job[]; mutations: unknown[] }

const api = {
  health: (): Promise<HealthStatus> => ipcRenderer.invoke('health'),
  settings: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings'),
  setSearchK: (k: number): Promise<{ k: number }> =>
    ipcRenderer.invoke('settings:setSearchK', k),
  search: (p: SearchParams): Promise<SearchResponse> => ipcRenderer.invoke('search', p),
  listSources: (): Promise<Source[]> => ipcRenderer.invoke('sources:list'),
  browseTiles: (
    sourceId: string,
    offset = 0,
    limit = 100,
    sort: TileSort = 'name'
  ): Promise<BrowseResponse> => ipcRenderer.invoke('browse:tiles', sourceId, offset, limit, sort),
  tileMeta: (thumbUrl: string): Promise<TileMeta> => ipcRenderer.invoke('tiles:meta', thumbUrl),
  revealTile: (thumbUrl: string): Promise<void> => ipcRenderer.invoke('tiles:reveal', thumbUrl),
  openTile: (thumbUrl: string): Promise<string> => ipcRenderer.invoke('tiles:open', thumbUrl),
  /** Open the OS folder picker; returns a token for scan/confirm, or null if cancelled. */
  pickSource: (
    mode: 'folder' | 'satimg'
  ): Promise<{ token: string; kind: 'xyz' | 'plain' | 'satimg'; folderName: string } | null> =>
    ipcRenderer.invoke('sources:pick', mode),
  /** Enumerate the picked folder into an import preview. */
  scanSource: (token: string): Promise<ImportPreview> => ipcRenderer.invoke('sources:scan', token),
  /** Commit the pending pick — starts embedding. */
  confirmAddSource: (
    token: string
  ): Promise<{ jobId: string; sourceId: string; kind: string; path: string }> =>
    ipcRenderer.invoke('sources:confirmAdd', token),
  /** Drop a pending pick without importing (modal cancelled). */
  cancelPick: (token: string): Promise<void> => ipcRenderer.invoke('sources:cancelPick', token),
  deleteSource: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('sources:delete', id),
  relinkSource: (id: string): Promise<{ ok: boolean } | null> => ipcRenderer.invoke('sources:relink', id),
  reconcileSource: (
    id: string
  ): Promise<{ counts: { added: number; removed: number; changed: number } }> =>
    ipcRenderer.invoke('sources:reconcile', id),
  reembedSource: (id: string): Promise<{ jobId: string }> => ipcRenderer.invoke('sources:reembed', id),
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  cancelJob: (id: string): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),

  getClasses: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('labels:classes'),
  addClass: (name: string): Promise<{ name: string; count: number }[]> =>
    ipcRenderer.invoke('labels:addClass', name),
  deleteClass: (name: string): Promise<{ name: string; count: number }[]> =>
    ipcRenderer.invoke('labels:deleteClass', name),
  setLabel: (sourceId: string, tile: string, label: string): Promise<unknown> =>
    ipcRenderer.invoke('labels:set', sourceId, tile, label),
  labelState: (keys: [string, string][]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('labels:state', keys),
  exportLabels: (): Promise<{ classes: string[]; count: number; dest: string }> =>
    ipcRenderer.invoke('labels:export'),

  onJobs: (cb: (snap: JobsSnapshot) => void): (() => void) => {
    const h = (_e: unknown, s: JobsSnapshot): void => cb(s)
    ipcRenderer.on('jobs:status', h)
    return () => ipcRenderer.removeListener('jobs:status', h)
  },
  onSourcesChanged: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('sources:changed', h)
    return () => ipcRenderer.removeListener('sources:changed', h)
  },
  onHealthReady: (cb: (h: HealthStatus) => void): (() => void) => {
    const h = (_e: unknown, s: HealthStatus): void => cb(s)
    ipcRenderer.on('health:ready', h)
    return () => ipcRenderer.removeListener('health:ready', h)
  },
  onHealthError: (cb: (msg: string) => void): (() => void) => {
    const h = (_e: unknown, s: string): void => cb(s)
    ipcRenderer.on('health:error', h)
    return () => ipcRenderer.removeListener('health:error', h)
  },
  onSidecarProgress: (cb: (p: SidecarProgress) => void): (() => void) => {
    const h = (_e: unknown, p: SidecarProgress): void => cb(p)
    ipcRenderer.on('sidecar:progress', h)
    return () => ipcRenderer.removeListener('sidecar:progress', h)
  },
  /** Backlog of setup log lines for a renderer that mounts mid-provision. */
  getSidecarLogs: (): Promise<string[]> => ipcRenderer.invoke('sidecar:logs'),
  onSidecarLog: (cb: (line: string) => void): (() => void) => {
    const h = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on('sidecar:log', h)
    return () => ipcRenderer.removeListener('sidecar:log', h)
  },
  /** Re-attempt sidecar startup after a failed first run (e.g. offline provisioning). */
  retryBoot: (): Promise<void> => ipcRenderer.invoke('sidecar:retry')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
