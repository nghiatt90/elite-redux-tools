import { useEffect, useRef, useState } from 'react'
import { useGameData } from '../../lib/GameDataContext'
import type { Ability } from '../../lib/types'

function explanationOf(a: Ability) {
  return a.expandedDescription ?? a.description
}

// True on devices with a real pointing device (mouse/trackpad); false on
// touch-primary devices, which don't get genuine hover semantics -- checked once
// since it doesn't change during a session.
const HAS_HOVER = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

/** Extended-explanation popover for an ability. Hover opens it where the device
 * actually supports hover; click/tap always opens (or, on a second tap/click,
 * closes) it.
 *
 * Hover handlers are only wired up at all when HAS_HOVER -- attaching them
 * unconditionally is the bug that first testing surfaced: some touch browsers fire
 * a synthetic mouseenter on tap with no matching mouseleave, so a `hovering` boolean
 * driven by real mouseenter/mouseleave events gets stuck true forever after the
 * first tap, and "tap again to close" silently stops working even though the click
 * handler is toggling `pinned` correctly underneath it. Gating hover behind a real
 * capability check removes the ambiguity instead of trying to out-guess event
 * ordering on every device.
 */
export default function AbilityPopover({
  ability,
  children,
  align = 'left',
}: {
  ability: Ability
  children: React.ReactNode
  /** Which edge the popup hangs from. AbilitiesPanel's two-column grid passes
   * 'right' for the innate column so the popup doesn't spill past the (often
   * narrow, ~440px on desktop) detail panel's right edge.
   */
  align?: 'left' | 'right'
}) {
  const { abilitiesById } = useGameData()
  const [hovering, setHovering] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovering || pinned
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pinned) return
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setPinned(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [pinned])

  const components = ability.components?.map((id) => abilitiesById.get(id)).filter((a): a is Ability => !!a)

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={HAS_HOVER ? () => setHovering(true) : undefined}
      onMouseLeave={HAS_HOVER ? () => setHovering(false) : undefined}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setPinned((v) => !v)
        }}
        className="text-left w-full cursor-help"
        aria-expanded={open}
      >
        {children}
      </button>

      {open && (
        <div
          role="tooltip"
          className={`absolute z-30 top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1 rounded-md border p-2.5 shadow-lg text-xs overflow-y-auto`}
          style={{
            width: 'min(85vw, 280px)',
            maxHeight: 'min(60vh, 320px)',
            background: 'var(--color-bg-elevated)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text)',
          }}
        >
          {components && components.length > 0 ? (
            <div className="space-y-2">
              <p className="font-semibold" style={{ color: 'var(--color-text-muted)' }}>
                Combines {components.length} abilities:
              </p>
              {components.map((c) => (
                <div key={c.id}>
                  <div className="font-semibold">{c.name}</div>
                  <p>{explanationOf(c)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p>{explanationOf(ability)}</p>
          )}
        </div>
      )}
    </div>
  )
}
