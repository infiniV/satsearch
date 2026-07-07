// IPC bridge: renderer -> main -> sidecar (spec §2). All calls go through the
// token-authed SidecarClient; the renderer never talks to the sidecar directly.
import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SidecarClient } from './services/api'
import type { SourcesCache } from './services/sources'
import { resolveThumbAbs } from './protocol'
import type { ImportPreview, TileMeta, TileSort } from '@shared/types'

/** satImg importer checkpoint — matches the app's active SigLIP2 model. */
const SATIMG_CHECKPOINT = 'google/siglip2-so400m-patch16-256'

/** Sniff whether a folder looks like an XYZ pyramid ({z}/{x}/{y}.img) or plain. */
export function detectKind(dir: string): 'xyz' | 'plain' {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const zDirs = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    for (const z of zDirs) {
      const xDirs = fs.readdirSync(path.join(dir, z.name), { withFileTypes: true })
      const x = xDirs.find((e) => e.isDirectory() && /^\d+$/.test(e.name))
      if (x) {
        const ys = fs.readdirSync(path.join(dir, z.name, x.name))
        if (ys.some((f) => /^\d+\.(jpg|jpeg|png|webp)$/i.test(f))) return 'xyz'
      }
    }
  } catch {
    /* fall through */
  }
  return 'plain'
}

export interface IpcDeps {
  client: SidecarClient
  sources: SourcesCache
}

/**
 * Register all IPC handlers immediately, backed by a `ready` promise that resolves
 * once the sidecar client + sources cache exist. The renderer mounts and invokes
 * `health`/`sources:list`/`labels:classes` right away, but the sidecar takes ~30s to
 * load its model — registering up front (rather than after `ensureReady`) means those
 * early calls await readiness instead of hitting a missing handler and logging noise.
 */
export function registerIpc(getReady: () => Promise<IpcDeps>): void {
  // Resolve deps per-invocation so calls that land during model load simply wait.
  // getReady() returns the current gate so a retried first-run attempt is picked up.
  const on = <A extends unknown[], R>(
    channel: string,
    fn: (deps: IpcDeps, ...args: A) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(await getReady(), ...(args as A)))
  }

  on('health', ({ client }) => client.health())

  on('settings', ({ client }) => client.settings())
  on('settings:setSearchK', ({ client }, k: number) => client.setSearchK(k))

  on('search', ({ client }, params: Parameters<SidecarClient['search']>[0]) =>
    client.search(params)
  )

  on('sources:list', ({ client }) => client.listSources())

  on('browse:tiles', ({ client }, sourceId: string, offset: number, limit: number, sort: TileSort) =>
    client.browseTiles(sourceId, offset, limit, sort)
  )

  // Tile file ops resolve the `app://thumb` url to a guarded absolute path via the
  // same SourcesCache + pathGuard the protocol handler uses — the renderer never
  // sees a filesystem path except the one meta returns for display/copy.
  on('tiles:meta', async ({ sources }, thumbUrl: string): Promise<TileMeta> => {
    const abs = resolveThumbAbs(thumbUrl, sources)
    const stat = await fs.promises.stat(abs)
    const meta: TileMeta = { path: abs, bytes: stat.size, mtime: stat.mtimeMs }
    try {
      const sharp = (await import('sharp')).default
      const m = await sharp(abs).metadata()
      meta.width = m.width
      meta.height = m.height
      meta.format = m.format
    } catch {
      /* non-image or unreadable — path/bytes/mtime still returned */
    }
    return meta
  })

  on('tiles:reveal', ({ sources }, thumbUrl: string) => {
    shell.showItemInFolder(resolveThumbAbs(thumbUrl, sources))
  })

  on('tiles:open', ({ sources }, thumbUrl: string) =>
    shell.openPath(resolveThumbAbs(thumbUrl, sources))
  )

  // Preview-then-confirm import (spec: import-preview). The picked absolute path stays
  // in the main process, keyed by an opaque token; the renderer only ever holds the
  // token, so `confirmAdd` never trusts a renderer-supplied path.
  type Pending = { kind: 'xyz' | 'plain' | 'satimg'; dir: string; folderName: string }
  const pending = new Map<string, Pending>()

  on('sources:pick', async (_deps, mode: 'folder' | 'satimg') => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    const kind = mode === 'satimg' ? 'satimg' : detectKind(dir)
    const folderName = path.basename(dir.replace(/[/\\]+$/, '')) || dir
    const token = randomUUID()
    pending.set(token, { kind, dir, folderName })
    return { token, kind, folderName }
  })

  on('sources:scan', async ({ client }, token: string): Promise<ImportPreview> => {
    const p = pending.get(token)
    if (!p) throw new Error('scan: unknown or expired pick token')
    const scan = await client.scanSource(p.kind, p.dir)
    return { ...scan, token, folderName: p.folderName, rootPath: p.dir }
  })

  on('sources:confirmAdd', async ({ client, sources }, token: string) => {
    const p = pending.get(token)
    if (!p) throw new Error('confirmAdd: unknown or expired pick token')
    const res =
      p.kind === 'satimg'
        ? await client.importSatimg(p.dir, SATIMG_CHECKPOINT)
        : await client.addSource(p.kind, p.dir)
    // Consume the token only once the job is enqueued, so a failed add can be retried.
    pending.delete(token)
    await sources.refresh()
    return { ...res, kind: p.kind, path: p.dir }
  })

  on('sources:cancelPick', (_deps, token: string) => {
    pending.delete(token)
  })

  on('sources:delete', async ({ client, sources }, id: string) => {
    const r = await client.deleteSource(id)
    await sources.refresh()
    return r
  })

  on('sources:relink', async ({ client, sources }, id: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const res = await client.relinkSource(id, r.filePaths[0])
    await sources.refresh()
    return res
  })

  on('sources:reconcile', ({ client }, id: string) => client.reconcileSource(id))
  on('sources:reembed', ({ client }, id: string) => client.reembedSource(id))

  on('jobs:list', ({ client }) => client.listJobs())
  on('jobs:cancel', ({ client }, id: string) => client.cancelJob(id))

  on('labels:classes', ({ client }) => client.getClasses())
  on('labels:addClass', ({ client }, name: string) => client.addClass(name))
  on('labels:deleteClass', ({ client }, name: string) => client.deleteClass(name))
  on('labels:set', ({ client }, sourceId: string, tile: string, label: string) =>
    client.setLabel(sourceId, tile, label)
  )
  on('labels:state', ({ client }, keys: [string, string][]) => client.labelState(keys))
  on('labels:export', ({ client }) => client.exportLabels())
}
