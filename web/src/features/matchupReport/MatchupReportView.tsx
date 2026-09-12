// Renders a MatchupReport (lib/matchupReport.ts). Deliberately keeps every framing
// decision the pure layer already made visible here rather than re-deciding them:
// the caveats list, the speed-tier note, and the fact that the AI-belief column is
// a BELIEF, not a second measurement of the truth. See that module's own doc for why
// each of these exists before changing how they're presented.
//
// Every list below is keyed by ARRAY INDEX, not by a data field, even though most of
// them look identifier-shaped (species id, move id, a species+level pair). Re-measured
// against the committed trainers.json rather than assumed: 23 trainers repeat a
// species within one raw party tier (one six times over), which collides a
// speciesId+level key since every mon in a report shares the same derived enemy
// level, and 116 party members repeat a move id within their OWN 4-move list, which
// collides a moveId key. These lists are fixed for the render (built once by
// buildMatchupReport, never reordered independently of it), so an index is exactly
// as stable as a "real" key would be, without the collision risk.

import { useMoveDisplayName, useGameData } from '../../lib/GameDataContext'
import { displayName } from '../../lib/displayName'
import { MATCHUP_REPORT_CAVEATS, type MatchupMonReport, type MatchupMoveEntry, type MatchupReport, type SpeedEntry } from '../../lib/matchupReport'

function formatDamage(entry: MatchupMoveEntry): string {
  if (entry.isImmune) return 'No effect'
  if (entry.maxRollDamage === null) return '—'
  return `${entry.maxRollDamage} (${entry.maxRollPercent!.toFixed(1)}%)`
}

function formatAiEstimate(entry: MatchupMoveEntry): string {
  if (entry.isImmune) return 'No effect'
  if (entry.aiEstimatedDamage === null) return '—'
  return `${entry.aiEstimatedDamage} (${entry.aiEstimatedPercent!.toFixed(1)}%)`
}

function MoveNameCell({ entry }: { entry: MatchupMoveEntry }) {
  const name = useMoveDisplayName(entry.moveId)
  return (
    <td className="py-1 pr-2 whitespace-nowrap">
      {name}
      {entry.unmodelled.length > 0 && (
        <span
          className="ml-1 text-xs"
          style={{ color: 'var(--color-danger)' }}
          title={entry.unmodelled.join('\n')}
        >
          ⚠
        </span>
      )}
    </td>
  )
}

/** "Your moves into it" -- one number, because there's no AI on your side to have a
 * belief about it. Worst case only, same as the damage calculator's own convention. */
function YourMovesTable({ entries }: { entries: MatchupMoveEntry[] }) {
  if (entries.length === 0) {
    return (
      <div>
        <div className="text-xs font-medium mb-1">Your moves</div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Select at least one move above to see your damage.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="text-xs font-medium mb-1">Your moves</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left" style={{ color: 'var(--color-text-muted)' }}>
            <th className="font-medium py-1 pr-2">Move</th>
            <th className="font-medium py-1 pr-2">Prio</th>
            <th className="font-medium py-1 pr-2">Worst-case damage</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
              <MoveNameCell entry={entry} />
              <td className="py-1 pr-2 tabular-nums">{entry.priority !== 0 ? entry.priority : ''}</td>
              <td className="py-1 pr-2 tabular-nums">{formatDamage(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * "Its moves into you" -- the point of the whole report, per the plan. TWO damage
 * columns that measure genuinely different things, not a number and a duplicate of
 * it: "Worst case" is the true maximum roll, reachable in the real game regardless
 * of what the AI thinks. "What the AI believes" is AI_CalcDamage's own crit-blended
 * estimate -- the number the trainer's AI actually uses to decide whether to finish
 * you off or switch out, which can UNDERSTATE the worst case because it evaluates
 * your held item as if it had never triggered (SetBattlerData,
 * battle_ai_util.c:520-543 -- see matchupReport.ts's own doc). A gap between the two
 * columns is not a bug in this report, it IS the finding: the AI can be wrong about
 * what it's about to do to you.
 *
 * The explanation above used to live only in each header's `title` tooltip --
 * invisible on touch devices and to anyone just scanning the page -- so it's also
 * printed as plain text under the table now; the tooltips stay as a per-column
 * reminder, not the only copy of the explanation.
 *
 * A dash in either column can mean any of three different things, distinguished only
 * by whether a warning triangle rides along (see MoveNameCell): a genuine STATUS
 * move has nothing to model and carries no warning; a move using one of
 * AI_CalcDamage's own dynamic-damage effects (Super Fang, Endeavor, Final Gambit,
 * Night Shade, Natures Madness/Ruination) is a real, unported engine gap and DOES
 * carry one (matchupReport.ts's DYNAMIC_DAMAGE_EFFECTS); Counter/Mirror Coat/Bide/
 * Seismic Toss are the same kind of gap and also carry one. All three used to render
 * as an identical bare dash before a review caught it -- the fix lives in
 * matchupReport.ts's own evaluateMoveEntry, not here, but is called out on this page
 * since this is where a reader actually meets it.
 */
function ItsMovesTable({ entries }: { entries: MatchupMoveEntry[] }) {
  if (entries.length === 0) {
    return (
      <div>
        <div className="text-xs font-medium mb-1">Its moves into you</div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          This Pokemon has no usable moves in the data -- nothing to report.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="text-xs font-medium mb-1">Its moves into you</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left" style={{ color: 'var(--color-text-muted)' }}>
            <th className="font-medium py-1 pr-2">Move</th>
            <th className="font-medium py-1 pr-2">Prio</th>
            <th className="font-medium py-1 pr-2" title="The true maximum roll -- what can actually happen to you if this move connects, regardless of what the AI thinks.">
              Worst case
            </th>
            <th
              className="font-medium py-1 pr-2"
              title="What the trainer's AI itself believes this move does, and the number it actually uses to decide whether to finish you off. Can be LOWER than the worst case: the AI evaluates as if your held item had never triggered."
            >
              What the AI believes
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => {
            const diverges = entry.maxRollDamage !== null && entry.aiEstimatedDamage !== null && entry.maxRollDamage !== entry.aiEstimatedDamage
            return (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                <MoveNameCell entry={entry} />
                <td className="py-1 pr-2 tabular-nums">{entry.priority !== 0 ? entry.priority : ''}</td>
                <td className="py-1 pr-2 tabular-nums">{formatDamage(entry)}</td>
                <td className="py-1 pr-2 tabular-nums" style={diverges ? { color: 'var(--color-text)', fontWeight: 600 } : undefined}>
                  {formatAiEstimate(entry)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
        "Worst case" is what can really happen. "What the AI believes" is the trainer's own (possibly wrong) estimate -- it can
        read lower because the AI evaluates as if your held item had never triggered yet.
      </p>
    </div>
  )
}

function MonSection({ mon, playerSpeed }: { mon: MatchupMonReport; playerSpeed: number }) {
  const { speciesById } = useGameData()
  const species = speciesById.get(mon.speciesId)
  const name = species ? displayName(species, speciesById) : mon.speciesId
  const speedComparison = mon.speed === playerSpeed ? 'speed tie' : mon.speed > playerSpeed ? 'faster than you' : 'slower than you'

  return (
    <div className="rounded-md border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold">{name}</h3>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Lv{mon.level} · Spe {mon.speed} ({speedComparison}) · {mon.maxHp} HP
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <YourMovesTable entries={mon.yourMoves} />
        <ItsMovesTable entries={mon.itsMoves} />
      </div>
    </div>
  )
}

function speedRowLabel(entry: SpeedEntry, speciesById: ReturnType<typeof useGameData>['speciesById']): string {
  if (entry.label === 'You') return 'You'
  const species = speciesById.get(entry.label)
  return species ? displayName(species, speciesById) : entry.label
}

export default function MatchupReportView({ report }: { report: MatchupReport }) {
  const { speciesById } = useGameData()
  const playerSpeed = report.speedTiers.find((e) => e.label === 'You')!.speed

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
        <div className="font-semibold mb-1">What this report is -- and isn't</div>
        <p className="mb-2">
          A turn-one snapshot of one matchup: who's faster, what you can do to it, and what it can do to you. This is not a build
          recommender -- the AI recomputes its move choice from your live stats every turn, so "invest until you survive its best
          move" has no fixed point. What's shown here is exact for what it claims: the true worst-case damage in each direction,
          and (for what it does to you) the trainer AI's own belief about that damage, which can genuinely be wrong -- see "Its
          moves into you" below for why those two numbers are shown separately rather than as one.
        </p>
        <ul className="list-disc pl-4 space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {MATCHUP_REPORT_CAVEATS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-md border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
        <h2 className="text-sm font-semibold mb-1">Speed tiers</h2>
        <table className="w-full text-xs mb-1">
          <tbody>
            {report.speedTiers.map((entry, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                <td className="py-1 pr-2 font-medium">{speedRowLabel(entry, speciesById)}</td>
                <td className="py-1 pr-2 tabular-nums">{entry.speed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
          {report.speedTierNote}
        </p>
      </div>

      {report.mons.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          This trainer has no configured party for the {report.tier} tier (or any tier) in this data -- nothing to report.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {report.mons.map((mon, i) => (
            <MonSection key={i} mon={mon} playerSpeed={playerSpeed} />
          ))}
        </div>
      )}
    </div>
  )
}
