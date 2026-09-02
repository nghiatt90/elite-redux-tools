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
  const { abilitiesById, speciesById } = useGameData()
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
      {/* Below sm, the stat bar/BST/hex-id columns are hidden entirely (see below),
          which used to leave the name and type columns pinned at their old narrow
          fixed widths instead of using that freed-up space -- clipping longer
          derived names ("Charizard Mega X" etc, now common since forms got their
          own distinct names) and a 3rd type chip on species with an ability-granted
          type. Name flexes to take whatever's left after the (still fairly
          generous) type column, rather than both being independently capped. */}
      <span className="flex-1 min-w-0 sm:flex-none sm:w-40 truncate text-sm font-medium">
        {displayName(species, speciesById)}
      </span>
      <span className="flex gap-1 w-[168px] sm:w-56 shrink-0 overflow-hidden">
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
