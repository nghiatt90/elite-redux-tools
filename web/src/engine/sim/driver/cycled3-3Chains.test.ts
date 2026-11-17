/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { TagBattle, TrainerChain } from '../../../lib/types'
import { loadBossTrainerIds } from './bossSet'
import { buildChains, type ChainSpec } from './chains'
import { FIGHTS } from './fights'

const encounters = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../../data/v2.65beta/encounters.json'),
    'utf8',
  ),
) as { trainerChains: TrainerChain[]; tagBattles: TagBattle[] }

const bossIds = loadBossTrainerIds()
const deferredIds = new Set(FIGHTS.filter((row) => row.deferred).flatMap((row) => row.trainerIds))
const v1Ids = new Set(bossIds.filter((id) => !deferredIds.has(id)))
const fullIds = new Set(bossIds)

const build = (allowed: ReadonlySet<string>) =>
  buildChains(encounters.trainerChains, encounters.tagBattles, allowed)
const v1Chains = build(v1Ids)
const fullChains = build(fullIds)

const trainerIds = (chain: ChainSpec) => chain.stages.flatMap((stage) => stage.trainerIds)

const JUAN = 'SootopolisCity_Gym_1F_EventScript_Juan'
const SPACE_CENTER = 'MossdeepCity_SpaceCenter_2F_EventScript_BattleThreeMagmaGrunts'
const MUSEUM = 'SlateportCity_OceanicMuseum_2F_EventScript_CaptStern'
const GROUPS = [
  'SootopolisCity_Gym_EventScript_TriggerBottomBattle',
  'SootopolisCity_Gym_EventScript_TriggerMiddleBattle',
  'SootopolisCity_Gym_EventScript_TriggerTopBattle',
]

describe('cycle d3-3: chains.ts', () => {
  it('v1 set: Space Center, museum, then Juan last', () => {
    expect(v1Chains.map((chain) => chain.id)).toEqual([SPACE_CENTER, MUSEUM, JUAN])
    expect(v1Chains.slice(0, -1)).toHaveLength(2)
    expect(trainerIds(v1Chains[0]!)).toEqual([
      'TRAINER_GRUNT_SPACE_CENTER_5',
      'TRAINER_GRUNT_SPACE_CENTER_6',
      'TRAINER_GRUNT_SPACE_CENTER_7',
    ])
    expect(trainerIds(v1Chains[1]!)).toEqual([
      'TRAINER_GRUNT_MUSEUM_1',
      'TRAINER_GRUNT_MUSEUM_2',
      'TRAINER_ARCHIE_SLATEPORT',
    ])
    expect(v1Chains.every((chain) => chain.evidence === 'script')).toBe(true)
    expect(fullChains.every((chain) => chain.evidence === 'script')).toBe(true)
  })

  it('full boss set: the three Gym 8 groups come back, six chains total', () => {
    // The derivation is only as good as the boss set: name any missing Gym 8 id.
    const gym8 = [
      'TRAINER_TIFFANY', 'TRAINER_BRIDGET', 'TRAINER_CRISSY', 'TRAINER_BETHANY',
      'TRAINER_DAPHNE', 'TRAINER_CONNIE', 'TRAINER_ANDREA',
      'TRAINER_OLIVIA', 'TRAINER_BRIANNA', 'TRAINER_ANNIKA',
    ]
    expect(gym8.filter((id) => !fullIds.has(id))).toEqual([])
    expect(fullChains.map((chain) => chain.id)).toEqual([SPACE_CENTER, MUSEUM, ...GROUPS, JUAN])
    expect(fullChains).toHaveLength(6)
    expect(fullChains.slice(0, -1)).toHaveLength(5)
  })

  it('excluded ids never appear in a chain', () => {
    const forbidden = [
      'TRAINER_VICTOR', // Winstrates: not a boss id
      'TRAINER_DRAGONITENITE_SAGE_1', // Sky Pillar: not a boss id
      'TRAINER_WALLY_VR_1', // healFree false
      'TRAINER_WALLY_VR_2',
      'TRAINER_WALLY_MAUVILLE', // a single healed fight
      'TRAINER_SHELLY_WEATHER_INSTITUTE', // a single healed fight
    ]
    for (const chains of [v1Chains, fullChains]) {
      const ids = chains.flatMap(trainerIds)
      for (const id of forbidden) expect(ids).not.toContain(id)
    }
  })

  it('drops a derived chain when one member falls outside the allowed set', () => {
    const partial = new Set(v1Ids)
    partial.delete('TRAINER_GRUNT_SPACE_CENTER_6')
    expect(build(partial).map((chain) => chain.id)).toEqual([MUSEUM, JUAN])
  })

  it('keeps a healFree false chain out even when every id is allowed', () => {
    const synthetic: TrainerChain = {
      map: 'TestMap',
      script: 'TestMap_EventScript_TwoFights',
      trainers: ['TRAINER_GRUNT_MUSEUM_1', 'TRAINER_ARCHIE_SLATEPORT'],
      healFree: false,
    }
    const chains = buildChains([...encounters.trainerChains, synthetic], encounters.tagBattles, v1Ids)
    expect(chains.map((chain) => chain.id)).not.toContain(synthetic.script)
    expect(chains.map((chain) => chain.id)).toContain(MUSEUM)
  })

  it('every derived stage order matches its trainerChains row and the script call order', () => {
    const entries = new Map(encounters.trainerChains.map((entry) => [entry.script, entry]))
    for (const chain of fullChains.slice(0, -1)) {
      const entry = entries.get(chain.id)!
      expect(entry).toBeDefined()
      expect(trainerIds(chain)).toEqual(entry.trainers)
      const text = readFileSync(
        resolve(
          import.meta.dirname,
          `../../../../../pipeline/.upstream/eliteredux-source/data/maps/${entry.map}/scripts.pory`,
        ),
        'utf8',
      )
      const body = scriptBody(text, entry.script)
      const indices = entry.trainers.map((id) => callIndex(text, body, id))
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
    }
  })

  it('Juan: two tag stages, and the data presence guard', () => {
    const juan = fullChains.at(-1)!
    expect(juan.id).toBe(JUAN)
    expect(juan.stages.map((stage) => stage.format)).toEqual(['tag', 'tag'])
    expect(juan.stages.map((stage) => stage.trainerIds)).toEqual([
      ['TRAINER_JUAN_1', 'TRAINER_WALLACE'],
      ['TRAINER_JUAN_5', 'TRAINER_WALLACE_5'],
    ])
    expect(() => build(v1Ids)).not.toThrow()
    expect(() => buildChains(encounters.trainerChains, [], v1Ids)).toThrow(/Juan row/)
    expect(() =>
      buildChains(
        encounters.trainerChains,
        encounters.tagBattles.filter((row) => row.script.endsWith('EventScript_Juan')),
        v1Ids,
      ),
    ).toThrow(/Juan row/)
  })
})

/** Body of a `script <name>{ ... }` block, empty for `.inc`-style `Name::` scripts. */
function scriptBody(text: string, script: string): string {
  const header = new RegExp(`(?:^|\\n)script ${script}\\{`).exec(text)
  if (!header) return ''
  const rest = text.slice(header.index + header[0].length)
  const next = /\nscript /.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/** Index of the first battle-call occurrence of `id`, in the body or the whole file.
 * The emitter's chain order is the trainerbattle call order, and the Gym 8 group
 * scripts also name every member in a `defeated(...)` guard in a different order
 * above the calls, so a bare first-occurrence match would read the guard. */
function callIndex(text: string, body: string, id: string): number {
  const call = new RegExp(`(?:trainerbattle[a-z_]*|starttagbattle)\\s*\\(?\\s*${id}\\b`)
  const inBody = call.exec(body)
  if (inBody) return inBody.index
  const inFile = call.exec(text)
  if (inFile) return inFile.index
  const bare = body.indexOf(id)
  return bare === -1 ? text.indexOf(id) : bare
}
