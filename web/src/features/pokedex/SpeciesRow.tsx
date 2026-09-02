import { Link } from 'react-router'
import { useGameData } from '../../lib/GameDataContext'
import { spriteUrl } from '../../lib/data'
import { displayName } from '../../lib/displayName'
import { formatHex } from '../../lib/hex'
import type { Species } from '../../lib/types'
import TypeChip from '../../components/TypeChip'
import { grantedTypes } from './grantedTypes'
import StatBar, { bst } from './StatBar'

export default function SpeciesRow({
  species,
  selected = false,
}: {
  species: Species
  selected?: boolean
}) {
  const { abilitiesById } = useGameData()
  const extraTypes = grantedTypes(species, abilitiesById)

  return (
    <Link
      to={`/pokemon/${species.id}`}
      data-selected={selected || undefined}
      className="flex items-center gap-2 sm:gap-3 px-3 h-11 border-b hover:bg-[var(--color-bg-hover)]"
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
      <span className="w-24 sm:w-40 shrink-0 truncate text-sm font-medium">{displayName(species)}</span>
      <span className="flex gap-1 w-32 sm:w-56 shrink-0 overflow-hidden">
        {species.types.map((t) => (
          <TypeChip key={t} type={t} />
        ))}
        {extraTypes.map((g) => (
          <TypeChip key={g.type} type={g.type} conditional title={`via ${g.viaAbility}`} />
        ))}
      </span>
      <span className="hidden sm:block shrink-0">
        <StatBar stats={species.baseStats} />
      </span>
      <span
        className="text-xs w-10 text-right tabular-nums hidden sm:inline-block"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {bst(species.baseStats)}
      </span>
      <span
        className="text-xs w-20 ml-auto text-right tabular-nums hidden md:inline-block"
        style={{ color: 'var(--color-text-muted)' }}
        title="Pokemon ID (internal species number)"
      >
        {formatHex(species.speciesNum)}
      </span>
    </Link>
  )
}
