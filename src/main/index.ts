import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { SidecarProgress } from '@shared/types'
import { SidecarManager } from './sidecar'
import { provision } from './provision'
import { SidecarClient } from './services/api'
import { SourcesCache } from './services/sources'
import {
  registerAppScheme,
  registerAppProtocol,
  setAppProtocolDeps,
  clearBasemapCache
} from './protocol'
import { registerIpc, type IpcDeps } from './ipc'

registerAppScheme() // must run before app.whenReady()

let win: BrowserWindow | null = null
let manager: SidecarManager | null = null
let streamCtl: AbortController | null = null

// The `ready` gate the IPC handlers await. It is re-created on retry so that a
// failed first run (e.g. offline during provisioning) can be re-attempted without
// restarting the app — handlers resolve against whichever attempt succeeds.
let resolveReady!: (d: IpcDeps) => void
let rejectReady!: (e: unknown) => void
let readyGate: Promise<IpcDeps>
function freshReadyGate(): void {
  readyGate = new Promise<IpcDeps>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  readyGate.catch(() => {
    /* handled per-invocation; swallow unhandled-rejection if never awaited */
  })
}

// Last boot-progress frame, re-sent when a (re)loaded renderer finishes loading so
// a window that mounts mid-provision doesn't sit on a blank gate.
let lastBoot: SidecarProgress | null = null
function sendProgress(p: SidecarProgress): void {
  lastBoot = p
  win?.webContents.send('sidecar:progress', p)
}

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

interface SidecarPaths {
  projectDir: string // sidecar source: pyproject.toml + uv.lock + satsearch_sidecar/
  pkg: string // satsearch_sidecar/ (for the content-hash version)
  provisioned: boolean // packaged → provision into userData; dev → use sidecar/.venv
  uvBin: string // bundled uv binary (packaged) or system `uv` (dev)
  runtimeDir: string // writable venv/python/cache home (packaged only)
  devPython: string // dev interpreter path (sidecar/.venv)
}

function sidecarPaths(): SidecarPaths {
  const dataDir = process.env.SATSEARCH_DATA_DIR || app.getPath('userData')
  const py = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  if (app.isPackaged) {
    const resDir = process.resourcesPath
    const projectDir = path.join(resDir, 'sidecar')
    return {
      projectDir,
      pkg: path.join(projectDir, 'satsearch_sidecar'),
      provisioned: true,
      uvBin: path.join(resDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
      runtimeDir: path.join(dataDir, 'runtime'),
      devPython: ''
    }
  }
  // Dev: the developer has already run `uv sync` (see README); reuse sidecar/.venv
  // and the system `uv` on PATH rather than provisioning into userData.
  const projectDir = path.join(__dirname, '../../sidecar')
  return {
    projectDir,
    pkg: path.join(projectDir, 'satsearch_sidecar'),
    provisioned: process.env.SATSEARCH_FORCE_PROVISION === '1',
    uvBin: process.env.SATSEARCH_UV || 'uv',
    runtimeDir: path.join(dataDir, 'runtime'),
    devPython: path.join(projectDir, '.venv', py)
  }
}

// Bootstrap config, computed once and reused by retries.
let paths: SidecarPaths
let sidecarEnv: { dataDir: string; checkpoint: string; device: string }

async function bootstrap(): Promise<void> {
  paths = sidecarPaths()
  sidecarEnv = {
    dataDir: process.env.SATSEARCH_DATA_DIR || app.getPath('userData'),
    checkpoint: process.env.SATSEARCH_MODEL || 'google/siglip2-so400m-patch16-256',
    device: process.env.SATSEARCH_DEVICE || 'cuda'
  }

  // Register IPC + open the window BEFORE the (first-run) provisioning + ~30s model
  // load. Handlers await the ready gate, so the renderer's mount-time calls resolve
  // once the sidecar is up instead of hitting a missing handler and logging noise.
  freshReadyGate()
  registerIpc(() => readyGate)
  ipcMain.handle('sidecar:retry', () => retrySidecar())
  // Register the app:// handler up front so the scheme is always handled, even
  // while the sidecar is still loading (deps are attached below once ready).
  registerAppProtocol()
  createWindow()

  await startSidecar()
}

/** Provision (first run only) → spawn/attach the sidecar → wire the client. On
 *  failure, reject the gate and surface a message the HealthGate renders with a
 *  Retry action. Safe to call again via retrySidecar(). */
async function startSidecar(): Promise<void> {
  try {
    const pythonBin = paths.provisioned
      ? await provision(
          { uvBin: paths.uvBin, projectDir: paths.projectDir, runtimeDir: paths.runtimeDir },
          sendProgress
        )
      : paths.devPython

    manager = new SidecarManager({
      pythonBin,
      sidecarPkgDir: paths.pkg,
      cwd: paths.projectDir,
      dataDir: sidecarEnv.dataDir,
      checkpoint: sidecarEnv.checkpoint,
      device: sidecarEnv.device
    })
    // Stream live boot progress (uv provisioning + parsed sidecar stderr) to the UI.
    manager.onProgress = sendProgress

    const { port, token } = await manager.ensureReady()
    const client = new SidecarClient(port, token)
    const sources = new SourcesCache(client)
    await sources.refresh()
    setAppProtocolDeps(sources, client)
    resolveReady({ client, sources })

    streamCtl = new AbortController()
    runJobStream(client, sources, streamCtl.signal)

    win?.webContents.send('health:ready', await client.health())
  } catch (e) {
    rejectReady(e) // unblock any pending IPC calls; renderer surfaces via health:error
    win?.webContents.send('health:error', e instanceof Error ? e.message : String(e))
  }
}

/** Re-attempt the whole sidecar startup after a failure (e.g. offline first run).
 *  Tears down the previous attempt and installs a fresh ready gate. */
async function retrySidecar(): Promise<void> {
  streamCtl?.abort()
  manager?.kill()
  manager = null
  lastBoot = null
  freshReadyGate()
  await startSidecar()
}

/**
 * Consume the sidecar's SSE job stream, reconnecting until aborted (the stream
 * ends on any sidecar hiccup; without a reconnect the Dashboard's live jobs would
 * silently freeze — audit #3). Source refresh is gated on a mutation high-water
 * mark (audit #1): the snapshot's `mutations` list is append-only and windowed, so
 * `length > 0` is permanently true after the first add/delete and every ingest
 * batch would otherwise re-refresh /sources + nuke the basemap cache. Refresh only
 * when the mutation tail actually changes.
 */
async function runJobStream(
  client: SidecarClient,
  sources: SourcesCache,
  signal: AbortSignal
): Promise<void> {
  let lastMutationSig: string | null = null
  const onStatus = (snap: { jobs: unknown[]; mutations: unknown[] }): void => {
    win?.webContents.send('jobs:status', snap)
    const sig = JSON.stringify(snap.mutations ?? [])
    if (sig !== lastMutationSig) {
      const advanced = lastMutationSig !== null // skip the first (baseline) frame
      lastMutationSig = sig
      if (advanced && (snap.mutations?.length ?? 0) > 0) {
        clearBasemapCache() // rootPath/zoom may have changed
        sources.refresh().then(() => win?.webContents.send('sources:changed'))
      }
    }
  }
  while (!signal.aborted) {
    try {
      await client.streamJobs(onStatus, signal)
    } catch {
      /* connection dropped — retry below unless we're shutting down */
    }
    if (signal.aborted) break
    await new Promise((r) => setTimeout(r, 1000))
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
  // A renderer that (re)loads mid-provision missed earlier progress frames; replay
  // the latest so the gate isn't blank.
  win.webContents.on('did-finish-load', () => {
    if (lastBoot) win?.webContents.send('sidecar:progress', lastBoot)
  })
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
