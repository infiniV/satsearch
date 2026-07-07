// Sidecar lifecycle (spec §4): single-instance ownership, spawn/attach via
// lockfile + token + content-hash version, PID-reuse guard, health gate.
// The Python sidecar is launched with child_process.spawn — utilityProcess.fork
// cannot execute an external interpreter (research §3).
import { spawn, ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { SidecarProgress } from '@shared/types'

/** Parse a tqdm/huggingface progress line from the sidecar's stderr into a boot
 * phase + percent. Returns null for lines with no recognizable progress. */
export function parseBootLine(chunk: string): SidecarProgress | null {
  // tqdm reprints via \r; a chunk can hold several frames — take the last %.
  const matches = [...chunk.matchAll(/(\d+)%\|/g)]
  if (matches.length === 0) return null
  const pct = Number(matches[matches.length - 1][1])
  if (/Loading weights/i.test(chunk)) {
    return { phase: 'loading', label: 'Loading the model onto the GPU', pct }
  }
  if (/\.safetensors|\.bin|Downloading|Fetching|Download/i.test(chunk)) {
    return { phase: 'downloading', label: 'Downloading the SigLIP2 model', pct }
  }
  return { phase: 'loading', label: 'Loading the model', pct }
}

export interface Lock {
  pid: number
  port: number
  token: string
  sidecarVersion: string
}

export interface HealthProbe {
  ok: boolean
  version?: string
}

/** Pure decision: attach to a running sidecar only if the lock, a token-authed
 *  health probe, and the content-hash version all agree; otherwise spawn fresh. */
export function decideAction(
  lock: Lock | null,
  expectedVersion: string,
  health: HealthProbe | null
): 'attach' | 'spawn' {
  if (!lock) return 'spawn'
  if (!health || !health.ok) return 'spawn'
  if (health.version !== expectedVersion) return 'spawn'
  if (lock.sidecarVersion !== expectedVersion) return 'spawn'
  return 'attach'
}

/** Token-authed /health probe. Returns null on any failure (dead port, 401, timeout). */
export async function probeHealth(
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500
): Promise<HealthProbe | null> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ready?: boolean; sidecarVersion?: string }
    return { ok: body.ready === true, version: body.sidecarVersion }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** OS-assigned free loopback port. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function readLock(dataDir: string): Lock | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'sidecar.lock'), 'utf8')) as Lock
  } catch {
    return null
  }
}

export function newToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** Content-hash of the sidecar python source — must equal the sidecar's own hash. */
export function computeSidecarVersion(pkgDir: string): string {
  const h = crypto.createHash('sha256')
  const files = fs.readdirSync(pkgDir).filter((f) => f.endsWith('.py')).sort()
  for (const f of files) {
    h.update(f)
    h.update('\0')
    h.update(fs.readFileSync(path.join(pkgDir, f)))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

/** True if `pid` is alive (best-effort PID-reuse guard input). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface SidecarOptions {
  pythonBin: string // path to the venv python (dev: sidecar/.venv/bin/python)
  sidecarPkgDir: string // path to satsearch_sidecar/ (for version hash)
  cwd: string // sidecar/ dir
  dataDir: string
  checkpoint: string
  device: string
}

export class SidecarManager {
  private proc: ChildProcess | null = null
  port = 0
  token = ''
  version = ''
  /** Set by the caller to receive live boot progress parsed from stderr. */
  onProgress?: (p: SidecarProgress) => void
  /** Set by the caller to receive raw sidecar output lines for the live setup log. */
  onLog?: (line: string) => void
  private lastPct: number | null = null

  constructor(private opts: SidecarOptions) {
    this.version = computeSidecarVersion(opts.sidecarPkgDir)
  }

  /** Ensure a healthy sidecar: attach to a matching running one, else spawn.
   *  Default deadline is generous: a cold spawn pays ~30s for `import torch` +
   *  CUDA init + model load before the health port opens (measured ~30s cold,
   *  ~25s warm on a 6GB GPU), so 30s was a dead-heat that intermittently failed
   *  with "sidecar did not become healthy in time". A fast attach still returns
   *  immediately — the extra headroom only applies to genuine cold starts. */
  async ensureReady(pollMs = 90000): Promise<{ port: number; token: string }> {
    const lock = readLock(this.opts.dataDir)
    if (lock) {
      const health = await probeHealth(lock.port, lock.token)
      if (decideAction(lock, this.version, health) === 'attach') {
        this.port = lock.port
        this.token = lock.token
        return { port: this.port, token: this.token }
      }
      // stale lock: kill its pid only if still alive (PID-reuse guard: a health
      // probe already failed, so the process is not our healthy sidecar)
      if (lock.pid && pidAlive(lock.pid)) {
        try {
          process.kill(lock.pid)
        } catch {
          /* already gone */
        }
      }
    }
    await this.spawn()
    await this.waitHealthy(pollMs)
    return { port: this.port, token: this.token }
  }

  private async spawn(): Promise<void> {
    this.port = await getFreePort()
    this.token = newToken()
    this.onProgress?.({ phase: 'starting', label: 'Starting the sidecar', pct: null })
    this.proc = spawn(this.opts.pythonBin, ['-m', 'satsearch_sidecar'], {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        SATSEARCH_PORT: String(this.port),
        SATSEARCH_TOKEN: this.token,
        SATSEARCH_DATA_DIR: this.opts.dataDir,
        SATSEARCH_MODEL: this.opts.checkpoint,
        SATSEARCH_DEVICE: this.opts.device,
        SATSEARCH_SIDECAR_VERSION: this.version
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc.stdout?.on('data', (d) => {
      const s = String(d)
      console.log('[sidecar]', s.trim())
      this.emitLogLines(s)
      if (/model loaded|serving/i.test(s)) {
        this.onProgress?.({ phase: 'warming', label: 'Warming up kernels', pct: null })
      }
    })
    this.proc.stderr?.on('data', (d) => {
      const s = String(d)
      console.error('[sidecar]', s.trim())
      this.emitLogLines(s)
      const p = parseBootLine(s)
      if (p && p.pct !== this.lastPct) {
        this.lastPct = p.pct
        this.onProgress?.(p)
      }
    })
  }

  private lastLogLine = ''
  /** Split a chunk into lines (collapsing \r progress reprints) and forward each
   *  non-empty line to onLog, skipping consecutive duplicates to avoid flooding. */
  private emitLogLines(chunk: string): void {
    for (const raw of chunk.split(/[\r\n]+/)) {
      const line = raw.trim()
      if (!line || line === this.lastLogLine) continue
      this.lastLogLine = line
      this.onLog?.(line)
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let delay = 150
    while (Date.now() < deadline) {
      const h = await probeHealth(this.port, this.token)
      if (h && h.ok) return
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.5, 1000)
    }
    throw new Error('sidecar did not become healthy in time')
  }

  kill(): void {
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        /* noop */
      }
      this.proc = null
    }
  }
}
