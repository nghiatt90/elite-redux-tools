import { typeColor } from '../lib/typeColors'

export default function TypeChip({ type }: { type: string }) {
  const { bg, fg } = typeColor(type)
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
      style={{ background: bg, color: fg }}
    >
      {type}
    </span>
  )
}
