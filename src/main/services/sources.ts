// Main-process cache of sourceId -> rootPath, synced from GET /sources and
// invalidated on source-mutation events (spec §2). Feeds the app://thumb protocol.
import type { Source } from '@shared/types'
import type { SidecarClient } from './api'

export class SourcesCache {
  private roots = new Map<string, string>()

  constructor(private client: SidecarClient) {}

  async refresh(): Promise<Source[]> {
    const sources = await this.client.listSources()
    this.roots = new Map(sources.map((s) => [s.id, s.rootPath]))
    return sources
  }

  rootPath(sourceId: string): string | undefined {
    return this.roots.get(sourceId)
  }

  /** Known source ids — for diagnostics when a thumb lookup misses. */
  ids(): string[] {
    return [...this.roots.keys()]
  }
}
