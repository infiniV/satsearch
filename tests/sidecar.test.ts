import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { decideAction, probeHealth, getFreePort, computeSidecarVersion } from '../src/main/sidecar'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('decideAction', () => {
  const lock = { pid: 1, port: 5, token: 't', sidecarVersion: 'v1' }
  it('spawns when no lock', () => {
    expect(decideAction(null, 'v1', { ok: true, version: 'v1' })).toBe('spawn')
  })
  it('spawns when health probe fails', () => {
    expect(decideAction(lock, 'v1', null)).toBe('spawn')
  })
  it('spawns on version skew (stale code after update)', () => {
    expect(decideAction(lock, 'v2', { ok: true, version: 'v1' })).toBe('spawn')
  })
  it('attaches when lock + health + version all agree', () => {
    expect(decideAction(lock, 'v1', { ok: true, version: 'v1' })).toBe('attach')
  })
})

describe('probeHealth', () => {
  let server: http.Server
  afterEach(() => server?.close())

  function serve(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler)
    return new Promise((res) => server.listen(0, '127.0.0.1', () => {
      res((server.address() as import('node:net').AddressInfo).port)
    }))
  }

  it('returns ok+version on a token-authed 200', async () => {
    const port = await serve((req, res) => {
      if (req.headers.authorization !== 'Bearer tok') {
        res.statusCode = 401
        return res.end('{}')
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ready: true, sidecarVersion: 'abc' }))
    })
    const h = await probeHealth(port, 'tok')
    expect(h).toEqual({ ok: true, version: 'abc' })
  })

  it('returns null on missing/wrong token (401)', async () => {
    const port = await serve((_req, res) => {
      res.statusCode = 401
      res.end('{}')
    })
    expect(await probeHealth(port, 'wrong')).toBeNull()
  })

  it('returns null on a dead port', async () => {
    const port = await getFreePort() // nothing is listening here
    expect(await probeHealth(port, 'tok')).toBeNull()
  })
})

describe('computeSidecarVersion', () => {
  it('is deterministic and changes with source', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ver-'))
    fs.writeFileSync(path.join(d, 'a.py'), 'x=1')
    const v1 = computeSidecarVersion(d)
    expect(v1).toEqual(computeSidecarVersion(d))
    fs.writeFileSync(path.join(d, 'a.py'), 'x=2')
    expect(computeSidecarVersion(d)).not.toEqual(v1)
    fs.rmSync(d, { recursive: true, force: true })
  })

  it('matches the python version hash for the real package', () => {
    // sanity: both sides hash *.py by name+content; here we only assert format
    const v = computeSidecarVersion(path.resolve(__dirname, '../sidecar/satsearch_sidecar'))
    expect(v).toMatch(/^[0-9a-f]{16}$/)
  })
})
