import { useEffect, useState } from 'react'

export type LabelClass = { name: string; count: number }

/** Label classes with their tagged-tile counts. */
export function useClasses(): { classes: LabelClass[]; refresh: () => void } {
  const [classes, setClasses] = useState<LabelClass[]>([])
  const refresh = (): void => {
    window.api.getClasses().then(setClasses).catch(() => {})
  }
  useEffect(refresh, [])
  return { classes, refresh }
}
