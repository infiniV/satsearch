// IPC bridge: renderer -> main -> sidecar (spec §2). All calls go through the
// token-authed SidecarClient; the renderer never talks to the sidecar directly.
import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SidecarClient } from './services/api'
import type { SourcesCache } from './services/sources'

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
export function registerIpc(ready: Promise<IpcDeps>): void {
  // Resolve deps per-invocation so calls that land during model load simply wait.
  const on = <A extends unknown[], R>(
    channel: string,
    fn: (deps: IpcDeps, ...args: A) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(await ready, ...(args as A)))
  }

  on('health', ({ client }) => client.health())

  on('search', ({ client }, params: Parameters<SidecarClient['search']>[0]) =>
    client.search(params)
  )

  on('sources:list', ({ client }) => client.listSources())

  on('sources:pickAndAdd', async ({ client, sources }) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    const kind = detectKind(dir)
    const res = await client.addSource(kind, dir)
    await sources.refresh()
    return { ...res, kind, path: dir }
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

  on('sources:importSatimg', async ({ client, sources }, checkpoint: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const res = await client.importSatimg(r.filePaths[0], checkpoint)
    await sources.refresh()
    return res
  })

  on('jobs:list', ({ client }) => client.listJobs())
  on('jobs:cancel', ({ client }, id: string) => client.cancelJob(id))

  on('labels:classes', ({ client }) => client.getClasses())
  on('labels:addClass', ({ client }, name: string) => client.addClass(name))
  on('labels:set', ({ client }, sourceId: string, tile: string, label: string) =>
    client.setLabel(sourceId, tile, label)
  )
  on('labels:state', ({ client }, keys: [string, string][]) => client.labelState(keys))
  on('labels:export', ({ client }) => client.exportLabels())
}
