import * as React from 'react'
import { cn } from '@/lib/utils'

export function Progress({
  value = 0,
  indeterminate = false,
  tone = 'default',
  className
}: {
  value?: number
  indeterminate?: boolean
  tone?: 'default' | 'signal'
  className?: string
}) {
  const pct = Math.min(100, Math.max(0, value))
  const fill = tone === 'signal' ? 'bg-signal' : 'bg-primary'
  return (
    <div
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-muted',
        className
      )}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        <div
          className={cn(
            'absolute inset-y-0 left-0 w-1/3 rounded-full animate-shimmer',
            fill
          )}
        />
      ) : (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', fill)}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  )
}
