// Path-traversal guard for app://thumb serving (spec §8).
// Fully URL-decode to a fixed point (defeats double-encoding), reject
// ..-segments / absolute / NUL, then require a separator-bounded realpath
// containment under root (defeats symlink escape and the /data/src-evil sibling bug).
import fs from 'node:fs'
import path from 'node:path'

function fullyDecode(s: string): string {
  let prev: string
  do {
    prev = s
    try {
      s = decodeURIComponent(s)
    } catch {
      throw new Error('malformed encoding')
    }
  } while (s !== prev)
  return s
}

/** Resolve an encoded rel_path under root, or throw. Returns an absolute path. */
export function safeResolve(root: string, relEncoded: string): string {
  const decoded = fullyDecode(relEncoded)
  if (decoded.includes('\0')) throw new Error('NUL in path')
  if (path.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) throw new Error('absolute path')
  const segs = decoded.split(/[/\\]/)
  if (segs.some((s) => s === '..')) throw new Error('traversal segment')

  const rootReal = fs.realpathSync(root)
  const resolved = path.resolve(rootReal, decoded)
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw new Error('escapes root')
  }
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved)
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new Error('symlink escapes root')
    }
  }
  return resolved
}
