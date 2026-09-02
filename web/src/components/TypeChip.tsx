import { typeColor } from '../lib/typeColors'

// species.json/moves.json store full symbolic names ("TYPE_GRASS"); types.json's own
// keys are already bare ("GRASS"). Accept either so callers don't have to think about it.
function bareName(type: string) {
  return type.startsWith('TYPE_') ? type.slice(5) : type
}

export default function TypeChip({ type }: { type: string }) {
  const bare = bareName(type)
  const { bg, fg } = typeColor(bare)
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
      style={{ background: bg, color: fg }}
    >
      {bare}
    </span>
  )
}
