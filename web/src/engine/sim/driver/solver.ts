// Set solver: given a fixed team of species and one boss fight, search each member's
// ability, item, nature, EV spread and moves for the set that wins most often.
//
// Fitness is the win rate over a fixed list of seeds (the same seeds for every candidate, so
// candidates are compared on the same dice), plus a small tie-breaker from how healthy the
// two sides were at the end, so a search can climb through teams that never win yet.
// Evaluation is injected (`FitnessEvaluator`) so the same search runs single-threaded in a
// test or across a worker pool from a CLI.

import type { StatKey } from '../../types'
import { playExpectimaxBattle } from './expectimax'
import { buildPlayerParty, type PlayerMonSpec } from './buildParty'
import type { SimDataBundle } from './loadSimData'

export type Team = PlayerMonSpec[]

export interface Fitness {
  winRate: number
  /** Mean end-of-battle position score, squashed into [-1, 1]. */
  meanScore: number
  games: number
}

export function fitnessValue(f: Fitness): number {
  return f.winRate + 0.02 * f.meanScore
}

/** Scores teams against one fixed fight. `games` seeded battles per team. */
export type FitnessEvaluator = (teams: Team[], games: number) => Promise<Fitness[]>

export const EV_TEMPLATES: Record<string, Partial<Record<StatKey, number>>> = {
  atkSpe: { atk: 252, spe: 252, hp: 4 },
  spaSpe: { spatk: 252, spe: 252, hp: 4 },
  hpAtk: { hp: 252, atk: 252, def: 4 },
  hpSpa: { hp: 252, spatk: 252, spdef: 4 },
  hpDef: { hp: 252, def: 252, spdef: 4 },
  hpSpd: { hp: 252, spdef: 252, def: 4 },
  atkDef: { atk: 252, def: 252, hp: 4 },
  spaSpd: { spatk: 252, spdef: 252, hp: 4 },
}

export const NATURES = [
  'NATURE_HARDY',
  'NATURE_ADAMANT',
  'NATURE_JOLLY',
  'NATURE_MODEST',
  'NATURE_TIMID',
  'NATURE_BOLD',
  'NATURE_CALM',
  'NATURE_IMPISH',
  'NATURE_CAREFUL',
]

export const ITEM_POOL = [
  'ITEM_LIFE_ORB',
  'ITEM_LEFTOVERS',
  'ITEM_FOCUS_SASH',
  'ITEM_CHOICE_BAND',
  'ITEM_CHOICE_SPECS',
  'ITEM_CHOICE_SCARF',
  'ITEM_ASSAULT_VEST',
  'ITEM_EVIOLITE',
  'ITEM_SITRUS_BERRY',
  'ITEM_LUM_BERRY',
  'ITEM_ROCKY_HELMET',
  'ITEM_WEAKNESS_POLICY',
  'ITEM_SHELL_BELL',
  'ITEM_EXPERT_BELT',
  'ITEM_HEAVY_DUTY_BOOTS',
  'ITEM_SCOPE_LENS',
  'ITEM_BOOSTER_ENERGY',
  'ITEM_LIGHT_CLAY',
  'ITEM_COVERT_CLOAK',
  'ITEM_SALAC_BERRY',
]

export const UTILITY_MOVES = new Set([
  'MOVE_SWORDS_DANCE',
  'MOVE_NASTY_PLOT',
  'MOVE_CALM_MIND',
  'MOVE_DRAGON_DANCE',
  'MOVE_BULK_UP',
  'MOVE_AGILITY',
  'MOVE_IRON_DEFENSE',
  'MOVE_RECOVER',
  'MOVE_ROOST',
  'MOVE_SOFT_BOILED',
  'MOVE_SLACK_OFF',
  'MOVE_REST',
  'MOVE_PROTECT',
  'MOVE_SUBSTITUTE',
  'MOVE_TOXIC',
  'MOVE_WILL_O_WISP',
  'MOVE_THUNDER_WAVE',
  'MOVE_STEALTH_ROCK',
  'MOVE_SPIKES',
  'MOVE_REFLECT',
  'MOVE_LIGHT_SCREEN',
  'MOVE_TAILWIND',
  'MOVE_TRICK_ROOM',
  'MOVE_PARTING_SHOT',
  'MOVE_KNOCK_OFF',
  'MOVE_U_TURN',
  'MOVE_VOLT_SWITCH',
  'MOVE_BATON_PASS',
  'MOVE_HEALING_WISH',
  'MOVE_TAUNT',
  'MOVE_ENCORE',
])

function learnableMoves(data: SimDataBundle, speciesId: string, level: number): string[] {
  const species = data.speciesById.get(speciesId)
  const learnset = species?.learnset as
    | { levelUp?: Array<{ level: number; moves: string[] }>; tutor?: string[] }
    | undefined
  const moves = new Set<string>()
  for (const entry of learnset?.levelUp ?? []) if (entry.level <= level) for (const m of entry.moves) moves.add(m)
  for (const m of learnset?.tutor ?? []) moves.add(m)
  return [...moves]
}

/** Moves worth considering for a species: its strongest damaging moves plus the utility whitelist. */
export function candidateMoves(data: SimDataBundle, speciesId: string, level: number, damagingCount = 14): string[] {
  const species = data.speciesById.get(speciesId)
  const ownTypes = new Set(((species?.types ?? []) as string[]).map((t) => t.replace('TYPE_', '')))
  const learnable = learnableMoves(data, speciesId, level)

  const damaging: Array<{ id: string; rank: number }> = []
  const utility: string[] = []
  for (const id of learnable) {
    const move = data.dataContext.move(id)
    if (!move) continue
    if (UTILITY_MOVES.has(id)) {
      utility.push(id)
      continue
    }
    if (!move.power || move.power <= 1) continue
    const stab = ownTypes.has((move.type ?? '').replace('TYPE_', '')) ? 1.5 : 1
    const accuracy = move.accuracy && move.accuracy > 0 ? move.accuracy / 100 : 1
    damaging.push({ id, rank: move.power * stab * accuracy })
  }
  damaging.sort((a, b) => b.rank - a.rank)
  return [...damaging.slice(0, damagingCount).map((d) => d.id), ...utility]
}

/** A sensible starting set: the four best-ranked damaging moves, Life Orb, a stat-appropriate nature and EVs. */
export function defaultSet(
  data: SimDataBundle,
  requestedSpecies: string,
  level: number,
  allowedStones: ReadonlySet<string>,
): PlayerMonSpec {
  const speciesId = megaFormsFor(data, requestedSpecies, allowedStones)[0] ?? requestedSpecies
  const species = data.speciesById.get(speciesId)
  const stats = species?.baseStats as Record<StatKey, number>
  const physical = (stats?.atk ?? 0) >= (stats?.spatk ?? 0)
  const moves = candidateMoves(data, speciesId, level, 4).filter((m) => !UTILITY_MOVES.has(m)).slice(0, 4)
  while (moves.length < 4) moves.push('')
  return {
    species: speciesId,
    level,
    nature: physical ? 'NATURE_ADAMANT' : 'NATURE_MODEST',
    evs: physical ? EV_TEMPLATES.atkSpe : EV_TEMPLATES.spaSpe,
    ability: (species?.abilities as string[] | undefined)?.[0] ?? null,
    item: speciesId === requestedSpecies ? 'ITEM_LIFE_ORB' : null,
    moves: moves.map((m) => (m === '' ? null : m)),
  }
}

/**
 * Mega forms of `speciesId`. Under Permanent Mega Mode a mon whose stone is in the bag is simply its
 * Mega species outside battle too (GetFormChangeForMon, src/pokemon.c:6019-6021; UndoMegaEvolution
 * returns early, src/battle_util.c:8192), so a Mega form is a species choice and uses no held item.
 */
export function megaFormsFor(data: SimDataBundle, speciesId: string, allowedStones: ReadonlySet<string>): string[] {
  const forms: string[] = []
  for (const s of data.speciesById.values()) {
    for (const m of (s.megas ?? []) as Array<{ from: string; item: string }>) {
      if (m.from === speciesId && allowedStones.has(m.item)) forms.push(s.id as string)
    }
  }
  return forms
}

/** The base species a form belongs to (itself when it is not a Mega form). */
export function baseSpeciesOf(data: SimDataBundle, speciesId: string): string {
  const megas = (data.speciesById.get(speciesId)?.megas ?? []) as Array<{ from: string }>
  return megas[0]?.from ?? speciesId
}

/** Every one-attribute change of one team member. */
export function neighbours(data: SimDataBundle, team: Team, index: number, allowedStones: ReadonlySet<string>): Team[] {
  const base = team[index]
  const out: Team[] = []
  const replace = (patch: Partial<PlayerMonSpec>): void => {
    const copy = team.map((m) => ({ ...m, moves: [...m.moves] }))
    copy[index] = { ...base, moves: [...base.moves], ...patch }
    out.push(copy)
  }

  const baseSpecies = baseSpeciesOf(data, base.species)
  for (const form of [baseSpecies, ...megaFormsFor(data, baseSpecies, allowedStones)]) {
    if (form !== base.species) {
      const formData = data.speciesById.get(form)
      replace({ species: form, ability: (formData?.abilities as string[] | undefined)?.[0] ?? null })
    }
  }
  const species = data.speciesById.get(base.species)
  for (const ability of (species?.abilities as string[] | undefined) ?? []) {
    if (ability && ability !== base.ability) replace({ ability })
  }
  for (const item of ITEM_POOL) {
    if (item !== base.item && data.itemsById.has(item)) replace({ item })
  }
  for (const nature of NATURES) if (nature !== base.nature) replace({ nature })
  for (const [name, evs] of Object.entries(EV_TEMPLATES)) {
    void name
    if (JSON.stringify(evs) !== JSON.stringify(base.evs)) replace({ evs })
  }
  const pool = candidateMoves(data, base.species, base.level ?? 50)
  for (let slot = 0; slot < 4; slot++) {
    for (const move of pool) {
      if (base.moves.includes(move)) continue
      const moves = [...base.moves]
      moves[slot] = move
      replace({ moves })
    }
  }
  return out
}

export interface SearchOptions {
  /** Cheap games used to screen neighbours. */
  screenGames: number
  /** Games used to confirm a finalist against the incumbent. */
  confirmGames: number
  /** Neighbours that survive screening. */
  finalists: number
  /** Full passes over the team. */
  passes: number
  /** Minimum fitness gain to accept a change. */
  epsilon: number
  /** Cap on neighbours screened per member per pass (random subset when exceeded). */
  maxNeighbours: number
  /** Mega stones the player owns at this point of the game; a Mega form needs its stone in the bag. */
  allowedStones: ReadonlySet<string>
  onProgress?: (message: string) => void
}

export const DEFAULT_SEARCH: SearchOptions = {
  screenGames: 4,
  confirmGames: 16,
  finalists: 3,
  passes: 2,
  epsilon: 0.01,
  maxNeighbours: 120,
  allowedStones: new Set<string>(),
}

function shuffled<T>(items: T[], seed: number): T[] {
  const arr = [...items]
  let s = seed >>> 0
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Coordinate ascent: for each member, screen its neighbours cheaply, confirm the best few, keep any real gain. */
export async function improveTeam(
  data: SimDataBundle,
  start: Team,
  evaluate: FitnessEvaluator,
  options: SearchOptions = DEFAULT_SEARCH,
): Promise<{ team: Team; fitness: Fitness }> {
  const log = options.onProgress ?? (() => {})
  let team = start
  let [current] = await evaluate([team], options.confirmGames)
  log(`start: win ${current.winRate.toFixed(2)} score ${current.meanScore.toFixed(2)}`)

  for (let pass = 0; pass < options.passes; pass++) {
    let changed = false
    for (let index = 0; index < team.length; index++) {
      const all = neighbours(data, team, index, options.allowedStones)
      const candidates = all.length > options.maxNeighbours ? shuffled(all, pass * 131 + index).slice(0, options.maxNeighbours) : all
      const [incumbentScreen] = await evaluate([team], options.screenGames)
      const screened = await evaluate(candidates, options.screenGames)
      const ranked = screened
        .map((fit, i) => ({ fit, team: candidates[i] }))
        .filter((c) => fitnessValue(c.fit) >= fitnessValue(incumbentScreen) - 0.001)
        .sort((a, b) => fitnessValue(b.fit) - fitnessValue(a.fit))
        .slice(0, options.finalists)
      if (ranked.length === 0) continue

      const confirmed = await evaluate(
        ranked.map((r) => r.team),
        options.confirmGames,
      )
      let bestIndex = -1
      let bestValue = fitnessValue(current) + options.epsilon
      confirmed.forEach((fit, i) => {
        if (fitnessValue(fit) > bestValue) {
          bestValue = fitnessValue(fit)
          bestIndex = i
        }
      })
      if (bestIndex >= 0) {
        team = ranked[bestIndex].team
        current = confirmed[bestIndex]
        changed = true
        log(`pass ${pass} member ${index} (${team[index].species}): win ${current.winRate.toFixed(2)} score ${current.meanScore.toFixed(2)}`)
      }
    }
    if (!changed) break
  }
  return { team, fitness: current }
}

/** Scores teams in this thread: `games` battles per team on seeds 1..games. */
export function createLocalEvaluator(
  data: SimDataBundle,
  trainer: import('./loadSimData').TrainerData,
  tier: 'ace' | 'elite' | 'hell' = 'elite',
  expectimax?: import('./expectimax').ExpectimaxOptions,
): FitnessEvaluator {
  return async (teams, games) => teams.map((team) => scoreTeam(data, trainer, tier, team, games, expectimax))
}

export function scoreTeam(
  data: SimDataBundle,
  trainer: import('./loadSimData').TrainerData,
  tier: 'ace' | 'elite' | 'hell',
  team: Team,
  games: number,
  expectimax?: import('./expectimax').ExpectimaxOptions,
  seedOffset = 0,
): Fitness {
  const level = Math.max(...team.map((m) => m.level ?? 50))
  const party = buildPlayerParty(team, level, data)
  let wins = 0
  let scoreSum = 0
  for (let g = 1; g <= games; g++) {
    const result = playExpectimaxBattle({ data, playerParty: party, opponentTrainer: trainer, tier, seed: seedOffset + g, expectimax })
    if (result.outcome === 'WON') wins++
    scoreSum += Math.max(-1, Math.min(1, result.finalScore / 6))
  }
  return { winRate: wins / games, meanScore: scoreSum / games, games }
}
