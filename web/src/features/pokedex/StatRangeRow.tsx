interface Props {
  label: string
  domainMin: number
  domainMax: number
  step: number
  min?: number // undefined = handle parked at domainMin -- no floor filter
  max?: number // undefined = handle parked at domainMax -- no ceiling filter
  onChange: (next: { min?: number; max?: number }) => void
}

/** One stat row: a single track, two draggable handles. A handle sitting at its
 * domain edge (0, or the domain max) means that bound isn't filtering -- same
 * convention the old single min-only slider used (drag to 0 = off) -- so there's
 * nothing extra to toggle; dragging a handle off its edge is what turns a bound on.
 * Built from two overlaid native <input type="range">s (see .dual-range in
 * index.css) rather than a custom drag implementation, so keyboard/touch dragging
 * keep working for free. */
export default function StatRangeRow({ label, domainMin, domainMax, step, min, max, onChange }: Props) {
  const effMin = min ?? domainMin
  const effMax = max ?? domainMax

  const pct = (v: number) => ((v - domainMin) / (domainMax - domainMin)) * 100

  function setMin(value: number) {
    const clamped = Math.min(value, effMax)
    onChange({ min: clamped > domainMin ? clamped : undefined, max })
  }

  function setMax(value: number) {
    const clamped = Math.max(value, effMin)
    onChange({ min, max: clamped < domainMax ? clamped : undefined })
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </span>
      <div className="dual-range flex-1 min-w-0">
        <div
          className="absolute top-1/2 left-0 right-0 h-1 rounded-full"
          style={{ background: 'var(--color-border)', transform: 'translateY(-50%)' }}
        />
        <div
          className="absolute top-1/2 h-1 rounded-full"
          style={{
            background: 'var(--color-accent)',
            left: `${pct(effMin)}%`,
            right: `${100 - pct(effMax)}%`,
            transform: 'translateY(-50%)',
          }}
        />
        <input
          type="range"
          aria-label={`${label} minimum`}
          min={domainMin}
          max={domainMax}
          step={step}
          value={effMin}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <input
          type="range"
          aria-label={`${label} maximum`}
          min={domainMin}
          max={domainMax}
          step={step}
          value={effMax}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
        {effMin}–{effMax}
      </span>
    </div>
  )
}
