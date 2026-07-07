import { useCallback, useEffect, useState } from 'react'
import type { HealthStatus, SidecarProgress } from '@shared/types'

/** Sidecar health + live boot progress. `readyTick` bumps each time the sidecar
 *  reports ready, so dependent data hooks can (re)load once the backend is up.
 *  `retry` re-attempts a failed startup (e.g. offline first-run provisioning). */
const MAX_LOG_LINES = 500

export function useHealth(): {
  health: HealthStatus | null
  error: string | null
  boot: SidecarProgress | null
  logs: string[]
  readyTick: number
  retry: () => void
} {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [boot, setBoot] = useState<SidecarProgress | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [readyTick, setReadyTick] = useState(0)

  useEffect(() => {
    window.api.health().then(setHealth).catch(() => {})
    // Backlog first (renderer may mount mid-provision), then live lines.
    window.api.getSidecarLogs().then(setLogs).catch(() => {})
    const offReady = window.api.onHealthReady((h) => {
      setHealth(h)
      setReadyTick((t) => t + 1)
    })
    const offErr = window.api.onHealthError(setError)
    const offBoot = window.api.onSidecarProgress(setBoot)
    const offLog = window.api.onSidecarLog((line) =>
      setLogs((prev) => {
        const next = prev.length >= MAX_LOG_LINES ? prev.slice(1) : prev.slice()
        next.push(line)
        return next
      })
    )
    return () => {
      offReady()
      offErr()
      offBoot()
      offLog()
    }
  }, [])

  const retry = useCallback(() => {
    // Clear the error so the gate returns to the progress view; main sends fresh
    // progress + a new health:ready / health:error for the retried attempt.
    setError(null)
    setLogs([])
    setBoot({ phase: 'starting', label: 'Retrying', pct: null })
    window.api.retryBoot().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return { health, error, boot, logs, readyTick, retry }
}
