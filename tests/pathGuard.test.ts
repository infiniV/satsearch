import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeResolve } from '../src/main/pathGuard'

let root: string
let outside: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-root-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-out-'))
  fs.mkdirSync(path.join(root, '19', '1'), { recursive: true })
  fs.writeFileSync(path.join(root, '19', '1', '2.jpg'), 'x')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('safeResolve', () => {
  it('resolves a valid nested tile', () => {
    const p = safeResolve(root, '19/1/2.jpg')
    expect(fs.readFileSync(p, 'utf8')).toBe('x')
  })

  it('url-decodes a normal encoded path', () => {
    const p = safeResolve(root, '19%2F1%2F2.jpg')
    expect(fs.existsSync(p)).toBe(true)
  })

  it('rejects a .. traversal', () => {
    expect(() => safeResolve(root, '../secret.txt')).toThrow(/traversal/)
  })

  it('neutralizes double-encoded traversal (%252e%252e) — resolves inside root, never escapes', () => {
    // Decoding exactly once yields the LITERAL single segment '%2e%2e%2fsecret.txt'
    // (no real '/' or '..'), so it resolves harmlessly under root — it can never
    // reach ../secret.txt. Decoding twice (the old bug) would forge '../'.
    const p = safeResolve(root, '%252e%252e%252fsecret.txt')
    expect(p.startsWith(fs.realpathSync(root) + path.sep)).toBe(true)
    expect(fs.existsSync(p)).toBe(false) // no such literal file — serveThumb 404s
  })

  it('still rejects single-encoded traversal (%2e%2e%2f -> ../)', () => {
    expect(() => safeResolve(root, '%2e%2e%2fsecret.txt')).toThrow(/traversal/)
  })

  it('decodes exactly once — a name with a single-encoded percent resolves literally', () => {
    // A tile literally named `img%41.png` is single-encoded by producers to
    // `img%2541.png`. One decode must yield `img%41.png` (not `imgA.png`).
    fs.writeFileSync(path.join(root, 'img%41.png'), 'literal-percent')
    const p = safeResolve(root, 'img%2541.png')
    expect(path.basename(p)).toBe('img%41.png')
    expect(fs.readFileSync(p, 'utf8')).toBe('literal-percent')
  })

  it('rejects an absolute path', () => {
    expect(() => safeResolve(root, '/etc/passwd')).toThrow(/absolute/)
  })

  it('rejects a symlink that escapes the root', () => {
    fs.symlinkSync(outside, path.join(root, 'link'))
    expect(() => safeResolve(root, 'link/secret.txt')).toThrow(/symlink|escape/)
  })

  it('rejects a sibling-prefix root (src-evil vs src)', () => {
    // root ends with a name; a sibling dir sharing the prefix must not pass
    const sibling = root + '-evil'
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'x.jpg'), 'nope')
    try {
      // '../<basename>-evil/x.jpg' would be a sibling; blocked by the .. check first,
      // but assert the containment logic directly: resolving into sibling must fail.
      expect(() => safeResolve(root, `../${path.basename(sibling)}/x.jpg`)).toThrow()
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })
})
