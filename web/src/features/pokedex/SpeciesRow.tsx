import { Link } from 'react-router'
import { spriteUrl } from '../../lib/data'
import type { Species } from '../../lib/types'
import TypeChip from '../../components/TypeChip'
import StatBar, { bst } from './StatBar'

export default function SpeciesRow({
  species,
  selected = false,
}: {
  species: Species
  selected?: boolean
}) {
  return (
    <Link
      to={`/pokemon/${species.id}`}
      data-selected={selected || undefined}
      className="flex items-center gap-3 px-3 h-11 border-b hover:bg-[var(--color-bg-hover)]"
      style={{
        borderColor: 'var(--color-border)',
        background: selected ? 'var(--color-bg-hover)' : undefined,
        boxShadow: selected ? 'inset 3px 0 0 var(--color-accent)' : undefined,
      }}
    >
      <img
        src={spriteUrl(species.id, 'icon')}
        alt=""
        width={32}
        height={32}
        className="pixelated shrink-0"
        loading="lazy"
      />
      <span className="w-40 shrink-0 truncate text-sm font-medium">{species.name}</span>
      <span className="flex gap-1 w-36 shrink-0 overflow-hidden">
        {species.types.map((t) => (
          <TypeChip key={t} type={t} />
        ))}
      </span>
      <StatBar stats={species.baseStats} className="shrink-0" />
      <span className="text-xs w-10 text-right tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
        {bst(species.baseStats)}
      </span>
      <span className="text-xs ml-auto tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
        #{species.nationalDexNum.toString().padStart(4, '0')}
      </span>
    </Link>
  )
}
