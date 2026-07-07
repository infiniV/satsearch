#!/usr/bin/env node
// Download the standalone `uv` binary for the HOST platform into resources/bin/, so
// electron-builder can bundle it as extraResources. The app runs it on first launch
// to provision the Python/torch environment (docs/DISTRIBUTION.md). Because native
// artifacts are per-OS, this runs on each release runner (Linux, Windows) against
// its own host — we never cross-bundle.
//
// Pin with UV_VERSION (default below). Force re-download with FETCH_UV_FORCE=1.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UV_VERSION = (process.env.UV_VERSION || '0.9.28').replace(/^v/, '')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'resources', 'bin')

// Map Node's platform/arch to uv's release target triple.
const TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const triple = TRIPLES[key]
  if (!triple) throw new Error(`Unsupported platform for uv bundle: ${key}`)

  const isWin = process.platform === 'win32'
  const binName = isWin ? 'uv.exe' : 'uv'
  const dest = path.join(binDir, binName)

  if (fs.existsSync(dest) && process.env.FETCH_UV_FORCE !== '1') {
    console.log(`[fetch-uv] ${binName} already present (${dest}); skipping. FETCH_UV_FORCE=1 to redownload.`)
    return
  }

  const ext = isWin ? 'zip' : 'tar.gz'
  const asset = `uv-${triple}.${ext}`
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
  console.log(`[fetch-uv] downloading ${url}`)

  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-uv-'))
  const archive = path.join(tmp, asset)
  fs.writeFileSync(archive, buf)

  // bsdtar (present on Windows 10+/macOS) extracts .zip too; GNU tar handles .tar.gz.
  execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' })

  const found = findFile(tmp, binName)
  if (!found) throw new Error(`Extracted archive did not contain ${binName}`)

  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(found, dest)
  if (!isWin) fs.chmodSync(dest, 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })

  const version = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim()
  console.log(`[fetch-uv] installed ${dest} (${version})`)
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

main().catch((e) => {
  console.error(`[fetch-uv] ${e.message}`)
  process.exit(1)
})
