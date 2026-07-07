import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Result } from '@shared/types'

export function MapView({
  results,
  onSelect
}: {
  results: Result[]
  onSelect: (r: Result) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { center: [20, 0], zoom: 2, minZoom: 0, maxZoom: 22 })
    // Basemap drawn from the user's own tiles via the sidecar-resolved app://basemap.
    L.tileLayer('app://basemap/{z}/{x}/{y}', {
      tileSize: 256,
      maxNativeZoom: 22,
      noWrap: true
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    // Pull the live theme token so markers stay in sync with the palette.
    const css = getComputedStyle(document.documentElement)
    const signal = css.getPropertyValue('--signal').trim() || '#e8c15a'
    const pts: L.LatLngExpression[] = []
    for (const r of results) {
      if (r.lat == null || r.lon == null) continue
      const marker = L.circleMarker([r.lat, r.lon], {
        radius: 5,
        color: signal,
        weight: 1.5,
        fillColor: signal,
        fillOpacity: 0.65
      })
      marker.on('click', () => onSelect(r))
      marker.addTo(layer)
      pts.push([r.lat, r.lon])
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { maxZoom: 17, padding: [40, 40] })
  }, [results, onSelect])

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg border border-border"
      style={{ background: 'var(--background)' }}
    />
  )
}
