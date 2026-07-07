import { useEffect, useState, type ReactNode } from 'react'
import { Cpu, HardDrive, Boxes, Tag, RefreshCw, Lock, Search } from 'lucide-react'
import { toast } from 'sonner'
import type { SettingsInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

/** Read-only settings: what the app is running on. v1 shows the active model, the
 *  runtime it loaded on, and rolled-up corpus/label/storage stats. Switching models
 *  is future work — the picker renders disabled off `model.switchable`. */
export function SettingsView({ readyTick }: { readyTick: number }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [depth, setDepth] = useState<number | null>(null)
  useEffect(() => {
    if (info) setDepth(info.search.k)
  }, [info])

  const load = () => {
    setLoading(true)
    window.api
      .settings()
      .then((s) => {
        setInfo(s)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  // (re)load on mount and whenever the sidecar reports ready
  useEffect(load, [readyTick])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
        <div className="flex items-center justify-between pt-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              What SatSearch is running on. Search depth is adjustable below.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Couldn’t load settings: {error}
          </div>
        )}

        {!info && !error && <p className="text-sm text-muted-foreground/70">Loading…</p>}

        {info && (
          <>
            {/* Model — the active checkpoint + a disabled picker for the future */}
            <Section icon={<Cpu className="h-4 w-4" />} title="Model">
              <Row label="Checkpoint" value={info.model.checkpoint} mono />
              <Row label="Device" value={info.model.device} />
              <Row label="Dimensions" value={`${info.model.dims}`} />
              <Row label="Fingerprint" value={info.model.fingerprint} mono truncate />
              {info.model.spec && (
                <>
                  <Row label="Image size" value={`${info.model.spec.image_size}px`} />
                  <Row
                    label="Preprocessing"
                    value={`transformers ${info.model.spec.preprocessing_impl.transformers} · torchvision ${info.model.spec.preprocessing_impl.torchvision} · pillow ${info.model.spec.preprocessing_impl.pillow}`}
                    mono
                    truncate
                  />
                </>
              )}
              {!info.model.switchable && (
                <div className="mt-1 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  Switching models is coming soon. Everything is embedded with the model
                  above — changing it would require re-embedding every source.
                </div>
              )}
            </Section>

            {/* Runtime — the hardware/backend it loaded on */}
            <Section icon={<HardDrive className="h-4 w-4" />} title="Runtime">
              <Row label="Device" value={info.runtime.device} />
              {info.runtime.gpuName && <Row label="GPU" value={info.runtime.gpuName} />}
              {info.runtime.vram != null && (
                <Row label="VRAM" value={`${(info.runtime.vram / 1e9).toFixed(1)} GB`} />
              )}
              {info.runtime.capability && (
                <Row label="Compute capability" value={info.runtime.capability} />
              )}
              {info.runtime.batchSize != null && (
                <Row label="Embed batch size" value={`${info.runtime.batchSize}`} />
              )}
              <Row label="Sidecar version" value={info.runtime.sidecarVersion} mono />
            </Section>

            {/* Search — the one editable knob in v1 */}
            <Section icon={<Search className="h-4 w-4" />} title="Search">
              <div className="py-2">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-muted-foreground">Search depth</dt>
                  <dd className="tnum text-sm text-foreground/90">
                    {(depth ?? info.search.k).toLocaleString()}
                  </dd>
                </div>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  How many top matches to rank per query. Higher finds more, costs more time.
                </p>
                <Slider
                  min={info.search.kMin}
                  max={info.search.kMax}
                  step={1000}
                  value={[depth ?? info.search.k]}
                  onValueChange={(v) => setDepth(v[0])}
                  onValueCommit={(v) => {
                    window.api
                      .setSearchK(v[0])
                      .then((r) => {
                        setDepth(r.k)
                        toast.success(`Search depth set to ${r.k.toLocaleString()}`)
                      })
                      .catch((e) => toast.error(String(e)))
                  }}
                />
              </div>
            </Section>

            {/* Index + Labels — rolled-up corpus stats */}
            <Section icon={<Boxes className="h-4 w-4" />} title="Index">
              <Row label="Sources" value={info.index.sources.toLocaleString()} />
              <Row label="Embedded tiles" value={info.index.tiles.toLocaleString()} />
              <Row label="Geolocated sources" value={info.index.geolocated.toLocaleString()} />
              <Row label="Snapshot" value={info.index.snapshotId} mono />
            </Section>

            <Section icon={<Tag className="h-4 w-4" />} title="Labels">
              <Row label="Classes" value={info.labels.classes.toLocaleString()} />
              <Row label="Tagged tiles" value={info.labels.tagged.toLocaleString()} />
            </Section>

            {/* Storage */}
            <Section icon={<HardDrive className="h-4 w-4" />} title="Storage">
              <Row label="Data directory" value={info.storage.dataDir} mono truncate />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-1">
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      <dl className="divide-y divide-border/60">{children}</dl>
    </section>
  )
}

function Row({
  label,
  value,
  mono,
  truncate
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-sm text-foreground/90',
          mono ? 'font-mono text-xs' : 'tnum',
          truncate && 'truncate'
        )}
        title={truncate ? value : undefined}
      >
        {value}
      </dd>
    </div>
  )
}
