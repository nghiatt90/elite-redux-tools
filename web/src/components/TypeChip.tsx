import { typeColor } from '../lib/typeColors'

// species.json/moves.json store full symbolic names ("TYPE_GRASS"); types.json's own
// keys are already bare ("GRASS"). Accept either so callers don't have to think about it.
function bareName(type: string) {
  return type.startsWith('TYPE_') ? type.slice(5) : type
}

interface Props {
  type: string
  /** True for a type granted by one of a species' abilities/innates rather than one
   * of its own two base types -- only one ability is ever active at a time, so this
   * isn't a guaranteed type the way the base two are. Rendered with a dashed border
   * and a title tooltip rather than a plain filled chip, so it doesn't read as
   * equally certain.
   */
  conditional?: boolean
  title?: string
}

export default function TypeChip({ type, conditional = false, title }: Props) {
  const bare = bareName(type)
  const { bg, fg } = typeColor(bare)
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
      style={
        conditional
          ? { background: 'transparent', color: bg, border: `1.5px dashed ${bg}` }
          : { background: bg, color: fg }
      }
      title={title}
    >
      {bare}
    </span>
  )
}
