import { useEffect, useState } from 'react'
import type { Job } from '@shared/types'

/** Live jobs. Seeded once at mount via listJobs() so a job already running before
 *  the window opened is visible, then kept current by the SSE `jobs` stream
 *  (which the main process reconnects on drop) — audit #3. */
export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([])

  useEffect(() => {
    window.api.listJobs().then(setJobs).catch(() => {})
    const off = window.api.onJobs((snap) => setJobs(snap.jobs))
    return off
  }, [])

  return jobs
}
