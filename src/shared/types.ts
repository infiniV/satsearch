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

/** A corpus tile without a relevance score — the browse/gallery counterpart to Result. */
export type GalleryTile = Omit<Result, 'score'>

export interface BrowseResponse {
  total: number
  offset: number
  limit: number
  tiles: GalleryTile[]
}

export type TileSort = 'name' | 'name-desc'

/** On-disk metadata for a single tile, resolved in the main process. */
export interface TileMeta {
  path: string
  bytes: number
  mtime: number
  width?: number
  height?: number
  format?: string
}

/** A tile shown in the detail slide-over — a search Result or a browsed GalleryTile. */
export type DetailTile = GalleryTile & { score?: number }

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

/** Live boot progress shown on the HealthGate. Covers both the one-time first-run
 * environment provisioning (uv: `provisioning` → `syncing` → `building`) and the
 * per-launch sidecar boot parsed from its stderr (`starting` → `downloading` →
 * `loading` → `warming`). `pct` is null while a phase has no measurable progress
 * (uv over a pipe emits discrete step events, not a byte %, so `syncing` is
 * indeterminate; the model download/load phases do report a real percentage). */
export interface SidecarProgress {
  phase: 'provisioning' | 'syncing' | 'building' | 'starting' | 'downloading' | 'loading' | 'warming'
  label: string
  pct: number | null
  /** Live sub-status, e.g. "1.2 GB downloaded" — reassurance that work is happening
   *  even when a precise percentage isn't available. */
  note?: string
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
