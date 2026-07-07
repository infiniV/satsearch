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

/** Preview of a picked folder, shown in the import-confirm modal before ingesting. */
export interface ImportPreview {
  /** Opaque handle for the pending pick; the picked path stays in the main process. */
  token: string
  kind: SourceKind
  folderName: string
  rootPath: string
  /** Images that will actually be embedded (XYZ: deepest zoom only). */
  imageCount: number
  /** Size on disk of the embeddable set; sampled+scaled for large corpora. */
  totalBytes: number
  approxBytes: boolean
  /** Rough embed time in seconds, or null if not computable. */
  estSeconds: number | null
  /** 'measured' from a past run on this device, or 'heuristic' first-run fallback. */
  estBasis: 'measured' | 'heuristic' | null
  /** XYZ pyramids: per-zoom tile counts, with the embed zoom flagged. */
  zoomBreakdown?: { zoom: number; count: number; embeds: boolean }[]
  /** Plain folders: top-level subfolder image counts. */
  subfolders?: { name: string; count: number }[]
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
  /** Live embedding throughput (tiles/second), refreshed on the progress cadence. */
  tilesPerSec?: number | null
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
  /** GPU model name (e.g. "NVIDIA GeForce RTX 3060"), or "cpu". */
  gpuName?: string | null
  /** CUDA compute capability, e.g. "8.6". */
  capability?: string | null
  /** Auto-resolved embed batch size for this GPU (null = CPU fallback). */
  batchSize?: number | null
  error?: string
}

/** Read-only app settings (sidecar `GET /settings`). v1 is display-only — the active
 *  model, the runtime it loaded on, and rolled-up corpus/label/storage stats. Model
 *  switching is future work (`model.switchable` is false; `availableModels` lists the
 *  one loaded), so the picker can render disabled without a later contract change. */
export interface ModelSpec {
  checkpoint_id: string
  hf_revision: string
  image_size: number
  resize_mode: string
  norm_mean: number[]
  norm_std: number[]
  tokenizer_max_length: number
  pooling: string
  preprocessing_impl: { transformers: string; torchvision: string; pillow: string }
}

export interface SettingsInfo {
  model: {
    checkpoint: string
    device: string
    dims: number
    fingerprint: string
    spec: ModelSpec | null
    switchable: boolean
  }
  availableModels: { checkpoint: string; active: boolean }[]
  runtime: {
    device: string
    gpuName?: string | null
    vram?: number | null
    capability?: string | null
    batchSize?: number | null
    sidecarVersion: string
  }
  index: { sources: number; tiles: number; geolocated: number; snapshotId: string }
  labels: { classes: number; tagged: number }
  storage: { dataDir: string }
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
