// app:// serving (spec §2, §9):
//   app://thumb/<sourceId>/<encodedRelPath>  — direct path-guarded file read
//   app://basemap/<z>/<x>/<y>                — sidecar-resolved coord math, sharp crop→PNG
import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { safeResolve } from './pathGuard'
import type { SourcesCache } from './services/sources'
import type { SidecarClient } from './services/api'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

// 1x1 transparent PNG for basemap gaps (JPEG can't be transparent — spec §9).
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

const basemapCache = new Map<string, Buffer>()
const BASEMAP_CACHE_MAX = 2048

export function clearBasemapCache(): void {
  basemapCache.clear()
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

async function serveThumb(url: URL, sources: SourcesCache): Promise<Response> {
  const parts = url.pathname.replace(/^\//, '').split('/')
  const sourceId = decodeURIComponent(parts[0] ?? '')
  const relEncoded = parts.slice(1).join('/')
  const root = sources.rootPath(sourceId)
  if (!root) return new Response('unknown source', { status: 404 })
  try {
    const abs = safeResolve(root, relEncoded)
    if (!fs.existsSync(abs)) return new Response('missing', { status: 404 })
    const data = await fs.promises.readFile(abs)
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
  } catch {
    return new Response('forbidden', { status: 403 })
  }
}

async function serveBasemap(url: URL, client: SidecarClient): Promise<Response> {
  const [zs, xs, ys] = url.pathname.replace(/^\//, '').split('/')
  const z = Number(zs)
  const x = Number(xs)
  const y = Number(ys)
  if (![z, x, y].every(Number.isFinite)) return new Response('bad tile', { status: 400 })
  const key = `${z}/${x}/${y}`
  const cached = basemapCache.get(key)
  if (cached) return new Response(new Uint8Array(cached), { headers: { 'content-type': 'image/png' } })

  const { file, crop } = await client.resolveTile(z, x, y)
  if (!file) {
    return new Response(new Uint8Array(TRANSPARENT_PNG), { headers: { 'content-type': 'image/png' } })
  }
  const sharp = (await import('sharp')).default
  let img = sharp(file)
  if (crop && crop.length === 3) {
    const [left, top, size] = crop
    img = img.extract({ left, top, width: size, height: size }).resize(256, 256)
  }
  const png = await img.png().toBuffer()
  if (basemapCache.size > BASEMAP_CACHE_MAX) basemapCache.clear()
  basemapCache.set(key, png)
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
}

export function registerAppProtocol(sources: SourcesCache, client: SidecarClient): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host === 'thumb') return serveThumb(url, sources)
    if (url.host === 'basemap') return serveBasemap(url, client)
    return new Response('not found', { status: 404 })
  })
}
