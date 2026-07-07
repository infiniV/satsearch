import { AlertTriangle } from 'lucide-react'
import type { HealthStatus, SidecarProgress } from '@shared/types'
import { Mark } from './Mark'

export function HealthGate({
  health,
  error,
  boot
}: {
  health: HealthStatus | null
  error: string | null
  boot: SidecarProgress | null
}) {
  if (health?.ready) return null

  const label = boot?.label ?? 'Starting the sidecar'
  const pct = boot?.pct ?? null
  const detail =
    boot?.phase === 'downloading'
      ? 'First run only — several gigabytes of model weights, cached locally for next time.'
      : boot?.phase === 'loading'
        ? 'Placing SigLIP2 on the accelerator. This takes a moment on a cold start.'
        : boot?.phase === 'warming'
          ? 'Almost ready — warming the inference kernels.'
          : 'Launching the local GPU inference process.'

  return (
    <div className="canvas fixed inset-0 z-50 flex items-center justify-center">
      <div className="flex w-full max-w-md flex-col items-start gap-7 px-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Mark className="h-4 w-4" />
          <span className="text-sm font-medium tracking-tight text-foreground">SatSearch</span>
        </div>

        {error ? (
          <ErrorPanel error={error} />
        ) : (
          <div className="w-full space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{detail}</p>
            </div>

            <div className="space-y-2.5">
              <BootBar pct={pct} />
              <p className="tnum text-xs text-muted-foreground">
                {pct != null ? `${pct}%` : 'working…'}
              </p>
            </div>
          </div>
        )}

        <Telemetry health={health} error={!!error} />
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

function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="w-full space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            The GPU sidecar couldn’t start
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Check that the Python sidecar and CUDA drivers are installed — see{' '}
          <span className="font-medium text-foreground">docs/HOW-TO-RUN.md</span>.
        </p>
      </div>
      <pre className="max-h-40 w-full overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
        {error}
      </pre>
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
