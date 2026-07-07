import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RotateCw, WifiOff } from 'lucide-react'
import type { HealthStatus, SidecarProgress } from '@shared/types'
import { Mark } from './Mark'
import { Button } from './ui/button'

const DETAILS: Record<SidecarProgress['phase'], string> = {
  provisioning: 'First run only — setting up an isolated Python runtime for the GPU sidecar.',
  syncing:
    'First run only — downloading the PyTorch + CUDA libraries (~2.5 GB). This is the long part; it’s cached for next time.',
  building: 'Assembling the environment from the downloaded packages.',
  starting: 'Launching the local GPU inference process.',
  downloading: 'First run only — several gigabytes of model weights, cached locally for next time.',
  loading: 'Placing SigLIP2 on the accelerator. This takes a moment on a cold start.',
  warming: 'Almost ready — warming the inference kernels.'
}

export function HealthGate({
  health,
  error,
  boot,
  logs,
  onRetry
}: {
  health: HealthStatus | null
  error: string | null
  boot: SidecarProgress | null
  logs: string[]
  onRetry?: () => void
}) {
  const ready = health?.ready === true
  const elapsed = useElapsed(!ready && !error)

  if (ready) return null

  const label = boot?.label ?? 'Starting the sidecar'
  const pct = boot?.pct ?? null
  const detail = (boot && DETAILS[boot.phase]) ?? 'Launching the local GPU inference process.'
  // Prefer the live sub-status ("1.2 GB downloaded"); append % when we also have one.
  const status = boot?.note
    ? boot.note + (pct != null ? ` · ${pct}%` : '')
    : pct != null
      ? `${pct}%`
      : 'working…'

  return (
    <div className="canvas fixed inset-0 z-50 flex items-center justify-center">
      <div className="flex w-full max-w-lg flex-col items-start gap-7 px-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Mark className="h-4 w-4" />
          <span className="text-sm font-medium tracking-tight text-foreground">SatSearch</span>
        </div>

        {error ? (
          <ErrorPanel error={error} logs={logs} onRetry={onRetry} />
        ) : (
          <div className="w-full space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{detail}</p>
            </div>

            <div className="space-y-2.5">
              <BootBar pct={pct} />
              <div className="flex items-center justify-between">
                <p className="tnum text-xs text-muted-foreground">{status}</p>
                <p className="tnum text-xs text-muted-foreground/60">{fmtElapsed(elapsed)}</p>
              </div>
            </div>

            <LogTail lines={logs} />
          </div>
        )}

        <Telemetry health={health} error={!!error} />
      </div>
    </div>
  )
}

/** Seconds elapsed while `running`, for an honest "this is still moving" clock. */
function useElapsed(running: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setN((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  return n
}

function fmtElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

/** Live tail of the setup log (uv + sidecar), auto-scrolled to the newest line, so the
 *  user can always see something is happening and spot a stall. */
function LogTail({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  if (lines.length === 0) return null
  const shown = lines.slice(-80)
  return (
    <div className="space-y-1.5">
      <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/60">
        Activity
      </p>
      <div
        ref={ref}
        className="h-36 w-full overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground"
      >
        {shown.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Determinate when we have a percentage; otherwise an honest indeterminate sweep. */
function BootBar({ pct }: { pct: number | null }) {
  return (
    <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-secondary">
      {pct != null ? (
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      ) : (
        <div className="absolute inset-y-0 left-0 w-1/3 animate-shimmer rounded-full bg-foreground" />
      )}
    </div>
  )
}

function ErrorPanel({
  error,
  logs,
  onRetry
}: {
  error: string
  logs: string[]
  onRetry?: () => void
}) {
  // First-run provisioning surfaces a network-specific message; show a friendlier
  // heading + icon for it (the raw detail is still in the log below).
  const offline = /internet connection|check your connection/i.test(error)
  return (
    <div className="w-full space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-destructive">
          {offline ? <WifiOff className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {offline ? 'First run needs an internet connection' : 'The GPU sidecar couldn’t start'}
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {offline ? (
            'The first launch downloads the GPU runtime and model (~5–6 GB), then runs fully offline. Reconnect and retry.'
          ) : (
            <>
              Check that an NVIDIA GPU + CUDA drivers are present — see{' '}
              <span className="font-medium text-foreground">docs/HOW-TO-RUN.md</span>.
            </>
          )}
        </p>
      </div>
      <pre className="max-h-40 w-full overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
        {error}
      </pre>
      <LogTail lines={logs} />
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-2">
          <RotateCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      )}
    </div>
  )
}

function Telemetry({ health, error }: { health: HealthStatus | null; error: boolean }) {
  const bits: string[] = []
  if (health?.sidecarVersion) bits.push(`v${health.sidecarVersion}`)
  if (health?.device) bits.push(health.device)
  if (health?.dims) bits.push(`${health.dims}-d`)
  const label = bits.length ? bits.join(' · ') : error ? 'halted' : 'connecting…'

  return (
    <p className="font-mono text-[0.6875rem] tracking-wide text-muted-foreground/60">{label}</p>
  )
}
