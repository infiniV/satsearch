import { contextBridge, ipcRenderer } from 'electron'
import type {
  HealthStatus,
  Job,
  SearchResponse,
  Source,
  SearchParams
} from '@shared/types'

type JobsSnapshot = { jobs: Job[]; mutations: unknown[] }

const api = {
  health: (): Promise<HealthStatus> => ipcRenderer.invoke('health'),
  search: (p: SearchParams): Promise<SearchResponse> => ipcRenderer.invoke('search', p),
  listSources: (): Promise<Source[]> => ipcRenderer.invoke('sources:list'),
  pickAndAddSource: (): Promise<{ jobId: string; sourceId: string; kind: string; path: string } | null> =>
    ipcRenderer.invoke('sources:pickAndAdd'),
  deleteSource: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('sources:delete', id),
  relinkSource: (id: string): Promise<{ ok: boolean } | null> => ipcRenderer.invoke('sources:relink', id),
  reconcileSource: (
    id: string
  ): Promise<{ counts: { added: number; removed: number; changed: number } }> =>
    ipcRenderer.invoke('sources:reconcile', id),
  reembedSource: (id: string): Promise<{ jobId: string }> => ipcRenderer.invoke('sources:reembed', id),
  importSatimg: (checkpoint: string): Promise<{ jobId: string; sourceId: string } | null> =>
    ipcRenderer.invoke('sources:importSatimg', checkpoint),
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  cancelJob: (id: string): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),

  getClasses: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('labels:classes'),
  addClass: (name: string): Promise<{ name: string; count: number }[]> =>
    ipcRenderer.invoke('labels:addClass', name),
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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
