// First-run environment provisioning (distribution model: thin installer + uv
// bootstrap). The installer ships the sidecar *source* + a bundled `uv` binary but
// NO virtualenv — a venv built on a CI machine is not relocatable (its interpreter
// symlink and `pyvenv.cfg` home hardcode build-machine paths). Instead, on first
// launch we run `uv sync` into a WRITABLE location under userData (the app's
// resources dir is read-only: AppImage is a read-only mount, nsis installs under
// Program Files), which provisions a managed CPython + the CUDA torch wheels for
// *this* machine. It is idempotent: a sentinel keyed on uv.lock lets subsequent
// launches skip straight to the venv (and stay fully offline).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { SidecarProgress } from '@shared/types'

export interface ProvisionOptions {
  /** Path to the bundled `uv` binary (resources/bin/uv[.exe]). */
  uvBin: string
  /** Project dir holding pyproject.toml + uv.lock + .python-version + the package. */
  projectDir: string
  /** Writable home for the venv, managed Python, and uv cache (under userData). */
  runtimeDir: string
}

/** Absolute path to the provisioned venv's interpreter for the current platform. */
export function venvPython(runtimeDir: string): string {
  const rel =
    process.platform === 'win32'
      ? path.join('venv', 'Scripts', 'python.exe')
      : path.join('venv', 'bin', 'python')
  return path.join(runtimeDir, rel)
}

/** Short content hash of the lockfile — the provisioning identity. */
export function lockHash(lockContent: string): string {
  return crypto.createHash('sha256').update(lockContent).digest('hex').slice(0, 16)
}

/** Re-provision only when the venv is missing or the lockfile changed since last sync. */
export function needsProvision(
  sentinel: string | null,
  currentHash: string,
  venvExists: boolean
): boolean {
  if (!venvExists) return true
  return sentinel !== currentHash
}

/** Map a chunk of uv's (progress-suppressed) output to a boot phase. uv over a pipe
 *  emits discrete step lines rather than a byte %, so `syncing` — where the ~2.5 GB
 *  of wheels actually download — is honestly indeterminate. Returns the most
 *  advanced phase seen in the chunk, or null if nothing recognizable. */
export function parseUvLine(chunk: string): SidecarProgress | null {
  let out: SidecarProgress | null = null
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const p = classifyUvLine(line)
    if (p) out = p
  }
  return out
}

function classifyUvLine(line: string): SidecarProgress | null {
  // Order matters: the Python-runtime lines (incl. "Downloading cpython-…") are more
  // specific than the generic "Downloading …" wheel line, so match them first.
  if (/cpython|Creating virtual environment|Using Python|Installing Python/i.test(line))
    return { phase: 'provisioning', label: 'Provisioning Python', pct: null }
  if (/^(Installed|Audited) \d+ package/i.test(line))
    return { phase: 'building', label: 'Finalizing the environment', pct: null }
  if (/^(Prepared \d+ package|Building )/i.test(line))
    return { phase: 'building', label: 'Building the environment', pct: null }
  if (/^(Downloading |Fetching |Resolved \d+ package)/i.test(line))
    return { phase: 'syncing', label: 'Downloading GPU libraries', pct: null }
  return null
}

function lastLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-n).join('\n')
}

/** Human-facing message for a failed `uv sync`. Network failures on first run are
 *  the common case and get a specific, actionable message (with a Retry in the UI). */
export function provisionErrorMessage(code: number | null, tail: string): string {
  const networky =
    /failed to (fetch|download|connect)|network|connection|dns error|temporary failure|failed to resolve|timed out|timeout|offline|error sending request|could not resolve host|no address associated/i.test(
      tail
    )
  if (networky) {
    return (
      'First run needs an internet connection to download the GPU runtime ' +
      '(~2.5 GB of PyTorch/CUDA wheels, cached for next time). ' +
      'Check your connection and retry.\n\n' +
      lastLines(tail, 8)
    )
  }
  return `Environment setup failed (uv exited ${code ?? 'unknown'}).\n\n${lastLines(tail, 12)}`
}

function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export interface ProvisionCallbacks {
  onProgress?: (p: SidecarProgress) => void
  /** Raw uv output lines, for the live setup log shown on the HealthGate. */
  onLog?: (line: string) => void
}

// Rough total download for the `gpu` group (torch + the nvidia-*-cu12 wheels + the
// managed CPython). Only used to turn the live cache-size counter into an approximate
// percentage; the "N MB" figure itself is exact.
const ESTIMATED_SYNC_BYTES = 2.6e9

/** Ensure a ready venv exists under `runtimeDir`, running `uv sync` only when needed.
 *  Returns the interpreter path to spawn the sidecar with. Emits progress + logs during
 *  a real sync; returns near-instantly (no network) on the idempotent fast path. */
export async function provision(
  opts: ProvisionOptions,
  cb: ProvisionCallbacks = {}
): Promise<string> {
  const py = venvPython(opts.runtimeDir)
  const currentHash = lockHash(readTextOrNull(path.join(opts.projectDir, 'uv.lock')) ?? '')
  const sentinelPath = path.join(opts.runtimeDir, '.provisioned')
  const sentinel = readTextOrNull(sentinelPath)

  if (!needsProvision(sentinel, currentHash, fs.existsSync(py))) return py

  fs.mkdirSync(opts.runtimeDir, { recursive: true })
  cb.onProgress?.({ phase: 'provisioning', label: 'Setting up the Python runtime', pct: null })
  await runUvSync(opts, cb)
  try {
    fs.writeFileSync(sentinelPath, currentHash)
  } catch {
    /* non-fatal: worst case we re-run an idempotent sync next launch */
  }
  return py
}

/** Total size of a directory tree in bytes (best-effort; ignores unreadable entries). */
function dirSize(dir: string): number {
  let total = 0
  let stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* transient during download — skip */
        }
      }
    }
  }
  return total
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  return `${Math.round(n / 1e6)} MB`
}

function runUvSync(opts: ProvisionOptions, cb: ProvisionCallbacks): Promise<void> {
  return new Promise((resolve, reject) => {
    const cacheDir = path.join(opts.runtimeDir, 'uv-cache')
    const env = {
      ...process.env,
      // Redirect every writable location uv touches into the app's runtime dir so
      // nothing is written to the read-only resources tree.
      UV_PROJECT_ENVIRONMENT: path.join(opts.runtimeDir, 'venv'),
      UV_CACHE_DIR: cacheDir,
      UV_PYTHON_INSTALL_DIR: path.join(opts.runtimeDir, 'python'),
      // Clean, line-based output we can parse (no animated bars / ANSI).
      UV_NO_PROGRESS: '1',
      NO_COLOR: '1'
    }
    // --frozen: use the shipped uv.lock exactly (no re-resolution).
    // --inexact: never remove packages already present (protects a dev venv that
    //            also has the `dev` group installed).
    const args = ['sync', '--frozen', '--inexact', '--group', 'gpu', '--project', opts.projectDir]
    const child = spawn(opts.uvBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

    // uv over a pipe emits no byte %, so measure the cache growing on disk to give a
    // real, moving "N MB downloaded" counter. Stops once installs begin (building).
    let downloading = true
    const poll = setInterval(() => {
      if (!downloading) return
      const bytes = dirSize(cacheDir)
      if (bytes <= 0) return
      cb.onProgress?.({
        phase: 'syncing',
        label: 'Downloading GPU libraries',
        pct: Math.min(99, Math.round((bytes / ESTIMATED_SYNC_BYTES) * 100)),
        note: `${fmtBytes(bytes)} downloaded`
      })
    }, 1500)

    let tail = ''
    let lineBuf = ''
    const onData = (d: Buffer): void => {
      const s = String(d)
      tail = (tail + s).slice(-4000)
      // Emit complete lines to the live log.
      lineBuf += s
      const lines = lineBuf.split(/\r?\n/)
      lineBuf = lines.pop() ?? ''
      for (const ln of lines) {
        const t = ln.trim()
        if (t) cb.onLog?.(t)
      }
      const p = parseUvLine(s)
      if (p) {
        if (p.phase === 'building') downloading = false // installs started; freeze the DL counter
        cb.onProgress?.(p)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      clearInterval(poll)
      reject(new Error(`Could not start the bundled uv (${opts.uvBin}): ${e.message}`))
    })
    child.on('close', (code) => {
      clearInterval(poll)
      if (lineBuf.trim()) cb.onLog?.(lineBuf.trim())
      code === 0 ? resolve() : reject(new Error(provisionErrorMessage(code, tail)))
    })
  })
}
