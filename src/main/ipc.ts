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

export function registerIpc(client: SidecarClient, sources: SourcesCache): void {
  ipcMain.handle('health', () => client.health())

  ipcMain.handle('search', (_e, params) => client.search(params))

  ipcMain.handle('sources:list', () => client.listSources())

  ipcMain.handle('sources:pickAndAdd', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    const kind = detectKind(dir)
    const res = await client.addSource(kind, dir)
    await sources.refresh()
    return { ...res, kind, path: dir }
  })

  ipcMain.handle('sources:delete', async (_e, id: string) => {
    const r = await client.deleteSource(id)
    await sources.refresh()
    return r
  })

  ipcMain.handle('sources:relink', async (_e, id: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const res = await client.relinkSource(id, r.filePaths[0])
    await sources.refresh()
    return res
  })

  ipcMain.handle('sources:reconcile', (_e, id: string) => client.reconcileSource(id))
  ipcMain.handle('sources:reembed', (_e, id: string) => client.reembedSource(id))

  ipcMain.handle('sources:importSatimg', async (_e, checkpoint: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const res = await client.importSatimg(r.filePaths[0], checkpoint)
    await sources.refresh()
    return res
  })

  ipcMain.handle('jobs:list', () => client.listJobs())
  ipcMain.handle('jobs:cancel', (_e, id: string) => client.cancelJob(id))

  ipcMain.handle('labels:classes', () => client.getClasses())
  ipcMain.handle('labels:addClass', (_e, name: string) => client.addClass(name))
  ipcMain.handle('labels:set', (_e, sourceId: string, tile: string, label: string) =>
    client.setLabel(sourceId, tile, label)
  )
  ipcMain.handle('labels:state', (_e, keys: [string, string][]) => client.labelState(keys))
  ipcMain.handle('labels:export', () => client.exportLabels())
}
