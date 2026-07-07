import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { SidecarManager } from './sidecar'
import { SidecarClient } from './services/api'
import { SourcesCache } from './services/sources'
import { registerAppScheme, registerAppProtocol, clearBasemapCache } from './protocol'
import { registerIpc } from './ipc'

registerAppScheme() // must run before app.whenReady()

let win: BrowserWindow | null = null
let manager: SidecarManager | null = null
let streamCtl: AbortController | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(bootstrap)
}

function sidecarPaths(): { dir: string; python: string; pkg: string } {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar')
    : path.join(__dirname, '../../sidecar')
  const py = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  return { dir, python: path.join(dir, '.venv', py), pkg: path.join(dir, 'satsearch_sidecar') }
}

async function bootstrap(): Promise<void> {
  const dataDir = process.env.SATSEARCH_DATA_DIR || app.getPath('userData')
  const sp = sidecarPaths()
  manager = new SidecarManager({
    pythonBin: sp.python,
    sidecarPkgDir: sp.pkg,
    cwd: sp.dir,
    dataDir,
    checkpoint: process.env.SATSEARCH_MODEL || 'google/siglip2-so400m-patch16-256',
    device: process.env.SATSEARCH_DEVICE || 'cuda'
  })

  createWindow()

  try {
    const { port, token } = await manager.ensureReady()
    const client = new SidecarClient(port, token)
    const sources = new SourcesCache(client)
    await sources.refresh()
    registerAppProtocol(sources, client)
    registerIpc(client, sources)

    streamCtl = new AbortController()
    client
      .streamJobs((snap) => {
        win?.webContents.send('jobs:status', snap)
        if ((snap.mutations?.length ?? 0) > 0) {
          clearBasemapCache() // rootPath/zoom may have changed
          sources.refresh().then(() => win?.webContents.send('sources:changed'))
        }
      }, streamCtl.signal)
      .catch(() => {
        /* stream ends on shutdown */
      })

    win?.webContents.send('health:ready', await client.health())
  } catch (e) {
    win?.webContents.send('health:error', String(e))
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.on('window-all-closed', () => {
  streamCtl?.abort()
  manager?.kill()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  streamCtl?.abort()
  manager?.kill()
})
