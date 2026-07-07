// Path-traversal guard for app://thumb serving (spec §8).
// Producers percent-encode exactly once (Python `quote`, JS `encodeURIComponent`),
// so we decode exactly once — decoding to a fixed point double-decodes a tile whose
// name legitimately contains `%` (e.g. `img%41.png` -> wrong file `imgA.png`).
// Security does not depend on that decode: after it we reject ..-segments / absolute
// / NUL and require separator-bounded realpath containment. A double-encoded probe
// like `%252e%252e%252f…` decodes once to the *literal* single segment `%2e%2e%2f…`,
// which resolves harmlessly inside root (defeats symlink escape + the /data/src-evil
// sibling-prefix bug too).
import fs from 'node:fs'
import path from 'node:path'

function decodeOnce(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    throw new Error('malformed encoding')
  }
}

/** Resolve an encoded rel_path under root, or throw. Returns an absolute path. */
export function safeResolve(root: string, relEncoded: string): string {
  const decoded = decodeOnce(relEncoded)
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
