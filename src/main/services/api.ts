// Token-authed HTTP client to the sidecar (spec §2). Used only by the main process.
import type {
  BrowseResponse,
  HealthStatus,
  ImportPreview,
  Job,
  SearchResponse,
  SettingsInfo,
  Source,
  TileSort
} from '@shared/types'

/** Scan result from the sidecar — the main process adds token/folderName/rootPath. */
export type ScanResult = Omit<ImportPreview, 'token' | 'folderName' | 'rootPath'>

export interface AddSourceResult {
  jobId: string
  sourceId: string
}

export class SidecarClient {
  constructor(
    private port: number,
    private token: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }

  async health(): Promise<HealthStatus> {
    return this.json(await this.fetchImpl(`${this.base()}/health`, { headers: this.auth() }))
  }

  async settings(): Promise<SettingsInfo> {
    return this.json(await this.fetchImpl(`${this.base()}/settings`, { headers: this.auth() }))
  }

  async search(params: {
    query?: string
    imageBytes?: ArrayBuffer
    ref?: { sourceId: string; name: string }
    sources?: string[]
    minScore?: number
    maxScore?: number
    from?: number
    limit?: number
  }): Promise<SearchResponse> {
    const fd = new FormData()
    if (params.query) fd.append('query', params.query)
    if (params.imageBytes) fd.append('image', new Blob([params.imageBytes]), 'query.bin')
    if (params.ref) fd.append('ref', JSON.stringify(params.ref))
    if (params.sources?.length) fd.append('sources', params.sources.join(','))
    if (params.minScore != null) fd.append('min_score', String(params.minScore))
    if (params.maxScore != null) fd.append('max_score', String(params.maxScore))
    fd.append('from_', String(params.from ?? 0))
    fd.append('limit', String(params.limit ?? 100))
    fd.append('sort', 'score-desc')
    return this.json(
      await this.fetchImpl(`${this.base()}/search`, { method: 'POST', headers: this.auth(), body: fd })
    )
  }

  async listSources(): Promise<Source[]> {
    return this.json(await this.fetchImpl(`${this.base()}/sources`, { headers: this.auth() }))
  }

  async browseTiles(
    sourceId: string,
    offset = 0,
    limit = 100,
    sort: TileSort = 'name'
  ): Promise<BrowseResponse> {
    const q = new URLSearchParams({ offset: String(offset), limit: String(limit), sort })
    return this.json(
      await this.fetchImpl(
        `${this.base()}/sources/${encodeURIComponent(sourceId)}/tiles?${q}`,
        { headers: this.auth() }
      )
    )
  }

  /** Preview a folder before importing. `kind` is 'satimg' for the satImg importer. */
  async scanSource(kind: 'xyz' | 'plain' | 'satimg', path: string): Promise<ScanResult> {
    return this.json(
      await this.fetchImpl(`${this.base()}/sources/scan`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ kind, path })
      })
    )
  }

  async addSource(kind: 'xyz' | 'plain', path: string, embedZoom?: number): Promise<AddSourceResult> {
    return this.json(
      await this.fetchImpl(`${this.base()}/sources`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ kind, path, embedZoom })
      })
    )
  }

  async deleteSource(id: string): Promise<{ deleted: boolean }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/sources/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.auth()
      })
    )
  }

  async relinkSource(id: string, path: string): Promise<{ ok: boolean }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/sources/${encodeURIComponent(id)}/relink`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ path })
      })
    )
  }

  async reconcileSource(id: string): Promise<{ counts: { added: number; removed: number; changed: number } }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/sources/${encodeURIComponent(id)}/reconcile`, {
        method: 'POST',
        headers: this.auth()
      })
    )
  }

  async reembedSource(id: string): Promise<{ jobId: string }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/reembed/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: this.auth()
      })
    )
  }

  async importSatimg(path: string, checkpoint: string): Promise<AddSourceResult> {
    return this.json(
      await this.fetchImpl(`${this.base()}/import/satimg`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ path, checkpoint })
      })
    )
  }

  async listJobs(): Promise<Job[]> {
    return this.json(await this.fetchImpl(`${this.base()}/jobs`, { headers: this.auth() }))
  }

  async getJob(id: string): Promise<Job> {
    return this.json(await this.fetchImpl(`${this.base()}/jobs/${id}`, { headers: this.auth() }))
  }

  async cancelJob(id: string): Promise<void> {
    await this.fetchImpl(`${this.base()}/jobs/${id}/cancel`, { method: 'POST', headers: this.auth() })
  }

  async getClasses(): Promise<{ name: string; count: number }[]> {
    return this.json(await this.fetchImpl(`${this.base()}/labels/classes`, { headers: this.auth() }))
  }

  async addClass(name: string): Promise<{ name: string; count: number }[]> {
    return this.json(
      await this.fetchImpl(`${this.base()}/labels/classes`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      })
    )
  }

  /** Delete an (empty) class. The sidecar returns 409 if it still has tagged tiles. */
  async deleteClass(name: string): Promise<{ name: string; count: number }[]> {
    return this.json(
      await this.fetchImpl(`${this.base()}/labels/classes/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: this.auth()
      })
    )
  }

  async setLabel(sourceId: string, tile: string, label: string): Promise<unknown> {
    return this.json(
      await this.fetchImpl(`${this.base()}/labels`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId, tile, label })
      })
    )
  }

  async labelState(keys: [string, string][]): Promise<Record<string, string>> {
    return this.json(
      await this.fetchImpl(`${this.base()}/labels/state`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ keys })
      })
    )
  }

  async exportLabels(): Promise<{ classes: string[]; count: number; dest: string }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/labels/export`, { method: 'POST', headers: this.auth() })
    )
  }

  async resolveTile(
    z: number,
    x: number,
    y: number,
    sources?: string[]
  ): Promise<{
    file: string | null
    crop: number[] | null
    composite?: { file: string; dst: number[] }[]
  }> {
    return this.json(
      await this.fetchImpl(`${this.base()}/tiles/resolve`, {
        method: 'POST',
        headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ z, x, y, sources })
      })
    )
  }

  jobsStreamUrl(): string {
    return `${this.base()}/jobs/stream`
  }

  /** Consume the SSE job stream, calling onStatus with each parsed snapshot. */
  async streamJobs(
    onStatus: (snap: { jobs: Job[]; mutations: unknown[] }) => void,
    signal: AbortSignal
  ): Promise<void> {
    const res = await this.fetchImpl(this.jobsStreamUrl(), { headers: this.auth(), signal })
    const reader = res.body?.getReader()
    if (!reader) return
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (line) {
          try {
            onStatus(JSON.parse(line.slice(5).trim()))
          } catch {
            /* heartbeat or malformed */
          }
        }
      }
    }
  }
}
