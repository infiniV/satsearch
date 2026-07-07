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

/** A basemap gap or an unrenderable tile: always a transparent 200, never a 500 — a
 *  500 makes Leaflet retry the tile forever and floods the console. */
function transparentTile(): Response {
  return new Response(new Uint8Array(TRANSPARENT_PNG), {
    headers: { 'content-type': 'image/png' }
  })
}

export function clearBasemapCache(): void {
  basemapCache.clear()
}

export function registerAppScheme(): void {
  // Must run before app 'ready'. corsEnabled + bypassCSP let the http://localhost
  // dev renderer load app:// images/fetches without cross-scheme CORS blocks.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

/**
 * Resolve an `app://thumb/<sourceId>/<encodedRel>` URL to a guarded absolute path,
 * or throw. Shared by the protocol handler and the tile-meta / reveal / open IPC so
 * they all apply the same path-traversal guard against the same source roots.
 */
export function resolveThumbAbs(thumbUrl: string, sources: SourcesCache): string {
  const url = new URL(thumbUrl)
  if (url.host !== 'thumb') throw new Error('not a thumb url')
  const parts = url.pathname.replace(/^\//, '').split('/')
  const sourceId = decodeURIComponent(parts[0] ?? '')
  const relEncoded = parts.slice(1).join('/')
  const root = sources.rootPath(sourceId)
  if (!root) throw new Error(`unknown source: ${sourceId}`)
  return safeResolve(root, relEncoded)
}

async function serveThumb(url: URL, sources: SourcesCache): Promise<Response> {
  const sourceId = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (!sources.rootPath(sourceId)) {
    console.warn('[thumb] 404 unknown source:', sourceId, '— known:', sources.ids())
    return new Response('unknown source', { status: 404 })
  }
  try {
    const abs = resolveThumbAbs(url.href, sources)
    if (!fs.existsSync(abs)) {
      console.warn('[thumb] 404 missing file:', abs)
      return new Response('missing', { status: 404 })
    }
    const data = await fs.promises.readFile(abs)
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
  } catch (e) {
    console.warn('[thumb] 403 forbidden:', url.href, String(e))
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

  const { file, crop, composite } = await client.resolveTile(z, x, y)

  // A gap (no imagery at this z/x/y — e.g. zoomed out below the source's native zoom)
  // is the common case, not an error: return the transparent tile WITHOUT touching
  // sharp. Importing/rendering only happens when there's actually pixels to produce.
  const hasComposite = composite && composite.length > 0
  if (!hasComposite && !file) return transparentTile()

  // Any render failure (unreadable file, out-of-bounds crop, sharp issue) degrades to a
  // transparent tile — never a 500. Leaflet retries 500s indefinitely, so a single bad
  // tile would otherwise flood the console and hammer the sidecar.
  let png: Buffer
  try {
    const sharp = (await import('sharp')).default
    if (hasComposite) {
      // under-zoom: downscale-composite native descendant tiles into one 256px tile
      const layers = await Promise.all(
        composite!.map(async ({ file: f, dst }) => {
          const [left, top, size] = dst
          const buf = await sharp(f).resize(size, size).png().toBuffer()
          return { input: buf, left, top }
        })
      )
      png = await sharp({
        create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
      })
        .composite(layers)
        .png()
        .toBuffer()
    } else {
      let img = sharp(file!)
      if (crop && crop.length === 3) {
        const [left, top, size] = crop
        img = img.extract({ left, top, width: size, height: size }).resize(256, 256)
      }
      png = await img.png().toBuffer()
    }
  } catch (e) {
    console.warn('[basemap] render failed, serving transparent:', key, String(e))
    return transparentTile()
  }

  if (basemapCache.size > BASEMAP_CACHE_MAX) basemapCache.clear()
  basemapCache.set(key, png)
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
}

// Deps arrive ~50s after the window opens (they need a live sidecar). Register
// the handler immediately at startup with a lazy holder so the `app://` scheme is
// always handled — a request before the sidecar is up just gets a 503, never the
// "unknown scheme" failure that comes from registering the handler too late.
let _sources: SourcesCache | null = null
let _client: SidecarClient | null = null

export function setAppProtocolDeps(sources: SourcesCache, client: SidecarClient): void {
  _sources = sources
  _client = client
}

export function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    try {
      if (url.host === 'thumb') {
        if (!_sources) return new Response('starting', { status: 503 })
        return await serveThumb(url, _sources)
      }
      if (url.host === 'basemap') {
        if (!_client) return new Response('starting', { status: 503 })
        // Basemap never 500s: a resolve/render failure degrades to a transparent tile
        // so Leaflet doesn't retry-storm a 500 across the whole viewport.
        try {
          return await serveBasemap(url, _client)
        } catch (e) {
          console.warn('[basemap] resolve failed, serving transparent:', request.url, String(e))
          return transparentTile()
        }
      }
      return new Response('not found', { status: 404 })
    } catch (e) {
      console.error('[app] handler error:', request.url, String(e))
      return new Response('error', { status: 500 })
    }
  })
}
