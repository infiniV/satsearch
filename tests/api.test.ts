import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SidecarClient } from '../src/main/services/api'

let server: http.Server

afterEach(() => server?.close())

function serve(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler)
  return new Promise((res) =>
    server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port))
  )
}

describe('SidecarClient', () => {
  it('sends the Bearer token on health', async () => {
    let seen = ''
    const port = await serve((req, res) => {
      seen = req.headers.authorization ?? ''
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ready: true, dims: 1152 }))
    })
    const c = new SidecarClient(port, 'sekret')
    const h = await c.health()
    expect(seen).toBe('Bearer sekret')
    expect(h.dims).toBe(1152)
  })

  it('posts search as multipart with the query field', async () => {
    let body = ''
    let ctype = ''
    const port = await serve((req, res) => {
      ctype = req.headers['content-type'] ?? ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ total: 1, snapshotId: 's', from: 0, belowWindow: false, results: [] }))
      })
    })
    const c = new SidecarClient(port, 't')
    const r = await c.search({ query: 'brick kiln', limit: 20 })
    expect(ctype).toMatch(/multipart\/form-data/)
    expect(body).toContain('brick kiln')
    expect(r.total).toBe(1)
  })

  it('posts scanSource as JSON and returns the preview', async () => {
    let body = ''
    let ctype = ''
    const port = await serve((req, res) => {
      ctype = req.headers['content-type'] ?? ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ kind: 'plain', imageCount: 42, totalBytes: 100, approxBytes: false, estSeconds: 5, estBasis: 'heuristic' }))
      })
    })
    const c = new SidecarClient(port, 't')
    const r = await c.scanSource('plain', '/some/dir')
    expect(ctype).toMatch(/application\/json/)
    expect(JSON.parse(body)).toEqual({ kind: 'plain', path: '/some/dir' })
    expect(r.imageCount).toBe(42)
  })

  it('throws on a non-ok response', async () => {
    const port = await serve((_req, res) => {
      res.statusCode = 400
      res.end('bad')
    })
    const c = new SidecarClient(port, 't')
    await expect(c.search({ query: 'x' })).rejects.toThrow(/400/)
  })

  it('posts setSearchK as JSON and returns the clamped k', async () => {
    let body = ''
    let method = ''
    const port = await serve((req, res) => {
      method = req.method ?? ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ k: 20000 }))
      })
    })
    const c = new SidecarClient(port, 't')
    const r = await c.setSearchK(20000)
    expect(method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ searchK: 20000 })
    expect(r.k).toBe(20000)
  })
})
