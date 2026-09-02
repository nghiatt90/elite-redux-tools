import { useVirtualizer } from '@tanstack/react-virtual'
import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { Species } from '../../lib/types'
import SpeciesRow from './SpeciesRow'

const ROW_HEIGHT = 44

export interface SpeciesListHandle {
  scrollToIndex: (index: number) => void
}

interface Props {
  species: Species[]
  selectedIndex: number
}

const SpeciesListView = forwardRef<SpeciesListHandle, Props>(function SpeciesListView(
  { species, selectedIndex },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: species.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: 'auto' }),
  }))

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
              <SpeciesRow species={s} selected={item.index === selectedIndex} />
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default SpeciesListView
