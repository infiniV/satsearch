import { describe, it, expect } from 'vitest'
import {
  parseUvLine,
  lockHash,
  needsProvision,
  provisionErrorMessage,
  venvPython
} from '../src/main/provision'

describe('parseUvLine', () => {
  it('maps CPython provisioning lines', () => {
    expect(parseUvLine('Downloading cpython-3.12.7-linux-x86_64')?.phase).toBe('provisioning')
    expect(parseUvLine('Creating virtual environment at: venv')?.phase).toBe('provisioning')
  })
  it('maps resolve/download to the (indeterminate) syncing phase', () => {
    expect(parseUvLine('Resolved 42 packages in 1.20s')).toEqual({
      phase: 'syncing',
      label: 'Downloading GPU libraries',
      pct: null
    })
    expect(parseUvLine('Downloading torch (2.5GiB)')?.phase).toBe('syncing')
  })
  it('maps prepared/installed to building', () => {
    expect(parseUvLine('Prepared 42 packages in 40s')?.phase).toBe('building')
    expect(parseUvLine('Installed 42 packages in 3s')?.phase).toBe('building')
    expect(parseUvLine('Audited 42 packages in 0.01s')?.phase).toBe('building')
  })
  it('returns the most advanced phase when a chunk holds several lines', () => {
    const chunk = 'Resolved 42 packages\nPrepared 42 packages\nInstalled 42 packages'
    expect(parseUvLine(chunk)?.phase).toBe('building')
  })
  it('returns null for unrecognized output', () => {
    expect(parseUvLine('warning: something unrelated')).toBeNull()
    expect(parseUvLine('')).toBeNull()
  })
})

describe('needsProvision', () => {
  it('provisions when the venv is missing regardless of sentinel', () => {
    expect(needsProvision('abc', 'abc', false)).toBe(true)
  })
  it('skips when venv exists and the lock hash matches', () => {
    expect(needsProvision('abc', 'abc', true)).toBe(false)
  })
  it('re-provisions when the lockfile changed', () => {
    expect(needsProvision('old', 'new', true)).toBe(true)
    expect(needsProvision(null, 'new', true)).toBe(true)
  })
})

describe('lockHash', () => {
  it('is stable and 16 hex chars', () => {
    const h = lockHash('some lock content')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(lockHash('some lock content')).toBe(h)
    expect(lockHash('other')).not.toBe(h)
  })
})

describe('provisionErrorMessage', () => {
  it('gives a network-specific message for connectivity failures', () => {
    const msg = provisionErrorMessage(1, 'error sending request for url: failed to connect')
    expect(msg).toMatch(/internet connection/i)
    expect(msg).toMatch(/2\.5 GB/)
  })
  it('falls back to a generic message otherwise', () => {
    const msg = provisionErrorMessage(2, 'error: package build failed: bad wheel')
    expect(msg).toMatch(/Environment setup failed/i)
    expect(msg).toMatch(/uv exited 2/)
  })
})

describe('venvPython', () => {
  it('points at the platform interpreter under the runtime dir', () => {
    const p = venvPython('/data/runtime')
    if (process.platform === 'win32') {
      expect(p).toContain('venv')
      expect(p.endsWith('python.exe')).toBe(true)
    } else {
      expect(p).toBe('/data/runtime/venv/bin/python')
    }
  })
})
