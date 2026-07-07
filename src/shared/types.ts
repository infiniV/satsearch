// Shared contract types — mirror the sidecar Pydantic models (spec §3).

export type SourceKind = 'xyz' | 'plain' | 'satimg-import'
export type Projection = 'web-mercator' | 'geodetic' | 'none'
export type Availability = 'available' | 'unavailable' | 'incompatible' | 'interrupted'

export interface TileLayout {
  template: string
  ext: string
  zOffset: number
  yScheme: 'xyz' | 'tms'
}

export interface Source {
  id: string
  label: string
  kind: SourceKind
  rootPath: string
  tileCount: number
  hasGeo: boolean
  projection: Projection
  minZoom?: number
  maxZoom?: number
  embedZoom?: number
  tileLayout?: TileLayout
  fingerprint: string
  attested?: boolean
  availability: Availability
  active: boolean
  rev: number
  createdAt?: string
}

export interface Result {
  name: string
  sourceId: string
  x?: number
  y?: number
  z?: number
  lat?: number
  lon?: number
  score: number
  thumbUrl: string
}

export interface SearchResponse {
  total: number
  snapshotId: string
  from: number
  belowWindow: boolean
  results: Result[]
}

export type JobKind = 'ingest' | 'import' | 'reembed'
export type JobState = 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  sourceId: string
  kind: JobKind
  state: JobState
  done: number
  total: number
  error?: string
  resumed?: boolean
  snapshotId?: string
  /** Most-recently embedded tile rel_path — drives the live preview thumbnail. */
  current?: string
}

export type Mutation = 'add' | 'import' | 'delete' | 'relink' | 'reembed'

export interface SourceMutationEvent {
  sourceId: string
  mutation: Mutation
  snapshotId: string
}

/** Live boot progress parsed from the sidecar's stderr during model load.
 * `pct` is null while the phase has no measurable progress (spawn / warming). */
export interface SidecarProgress {
  phase: 'starting' | 'downloading' | 'loading' | 'warming'
  label: string
  pct: number | null
}

export interface HealthStatus {
  ready: boolean
  phase: 'provisioning' | 'downloading-model' | 'warming' | 'ready' | 'error'
  device: string
  dims: number
  fingerprint: string
  sidecarVersion: string
  vram?: number | null
  ram?: number | null
  error?: string
}

export interface SearchParams {
  query?: string
  imageBytes?: ArrayBuffer
  ref?: { sourceId: string; name: string }
  sources?: string[]
  minScore?: number
  maxScore?: number
  from?: number
  limit?: number
}
