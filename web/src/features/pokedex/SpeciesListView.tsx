import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { Species } from '../../lib/types'
import SpeciesRow from './SpeciesRow'

const ROW_HEIGHT = 44

export default function SpeciesListView({ species }: { species: Species[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: species.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const items = virtualizer.getVirtualItems()

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => {
          const s = species[item.index]
          return (
            <div
              key={s.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <SpeciesRow species={s} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
