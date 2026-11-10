/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ABILITY_HOOK_ALLOWLIST,
  NOTE_ONLY_SET,
  PORTED_ATTACKER_BRANCH_ABILITIES,
  PORTED_CAN_STATUS_TYPE_ABILITIES,
  PORTED_DEFENDER_BRANCH_ABILITIES,
  PORTED_MODIFY_EFFECT_CHANCE_ABILITIES,
  PORTED_MODIFY_MOVE_FLAGS_ABILITIES,
  PORTED_REACTIVE_ABILITIES,
  PORTED_RECOIL_ABILITIES_SET,
  classifyPair,
  extractAttackerBranchAbilities,
  extractCanStatusTypeAbilities,
  extractDefenderBranchAbilities,
  extractFunctionSlice,
  extractModifyEffectChanceAbilities,
  extractModifyMoveFlagsAbilities,
  extractMoveFlagPredicateAbilities,
  extractReactiveAbilities,
  extractRecoilAbilities,
  generateInventoryDoc,
  isDirectlyPorted,
  loadTestMentionedAbilities,
  runInventory,
  type AbilityHookRecord,
  type MoveFlagFamily,
} from './driver/abilityHookInventory'
import { ON_RECOIL_ABILITIES, PORTED_ATTACKER_ABILITIES, PORTED_DEFENDER_ABILITIES } from './moveEnd'
import { POISON_PUPPETEER_CLONE_ABILITIES } from './statBuffs'

const SIM_DIR = fileURLToPath(new URL('.', import.meta.url))
const ENGINE_DIR = fileURLToPath(new URL('../', import.meta.url))
const DATA_DIR = join(SIM_DIR, '..', '..', '..', '..', 'data', 'v2.65beta')
const DOC_PATH = join(SIM_DIR, '..', '..', '..', '..', 'docs', 'battle-sim', 'ability-hook-inventory.md')

const abilityHooks: Record<string, AbilityHookRecord> = JSON.parse(
  readFileSync(join(DATA_DIR, 'abilityHooks.json'), 'utf8'),
)
const rawMoves = JSON.parse(readFileSync(join(DATA_DIR, 'moves.json'), 'utf8')) as Array<Record<string, unknown>>

const statusEffectsSource = readFileSync(join(SIM_DIR, 'statusEffects.ts'), 'utf8')
const moveEndSource = readFileSync(join(SIM_DIR, 'moveEnd.ts'), 'utf8')
const statBuffsSource = readFileSync(join(SIM_DIR, 'statBuffs.ts'), 'utf8')
const moveTargetFlagsSource = readFileSync(join(SIM_DIR, 'moveTargetFlags.ts'), 'utf8')

/** Ability ids `abilityHooks.json` defines for a hook kind. */
function definedFor(hook: string): string[] {
  return Object.entries(abilityHooks)
    .filter(([, record]) => Boolean(record.hooks?.[hook]))
    .map(([id]) => id)
    .sort()
}

/** Deletes exactly one source line; the result is not a program, which is fine for text extractors. */
function dropLineContaining(source: string, needle: string): string {
  const lines = source.split('\n')
  const kept = lines.filter((line) => !line.includes(needle))
  expect(kept.length, `expected exactly one line containing ${needle}`).toBe(lines.length - 1)
  return kept.join('\n')
}

/** Deletes every source line containing `needle`; used when the same literal is duplicated. */
function dropLinesContaining(source: string, needle: string): string {
  const lines = source.split('\n')
  const kept = lines.filter((line) => !line.includes(needle))
  expect(kept.length, `expected at least one line containing ${needle}`).toBeLessThan(lines.length)
  return kept.join('\n')
}

/**
 * Removes the block whose header contains `marker` (from the marker through its matching `}`).
 * Copied from cycle150dInventory.test.ts: the source need not stay a valid program.
 */
function removeBranch(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

// ---------------------------------------------------------------------------
// (3a) onCanStatusType reads the two CanXType functions.
// ---------------------------------------------------------------------------

describe('Cycle 150g (3a) - onCanStatusType comes from canPoisonType/canParalyzeType', () => {
  it('extracts exactly the eight data-defined ids, including Angel\'s Wrath', () => {
    const extracted = extractCanStatusTypeAbilities(statusEffectsSource)
    expect(extracted).toEqual(PORTED_CAN_STATUS_TYPE_ABILITIES)
    expect([...extracted].sort()).toEqual(definedFor('onCanStatusType'))
    expect(extracted.has('ABILITY_ANGELS_WRATH')).toBe(true) // move === 'MOVE_POISON_STING' branch
    expect(extracted).toEqual(
      new Set(['ABILITY_ACIDIC_SLIME', 'ABILITY_ANGELS_WRATH', 'ABILITY_CORROSION', 'ABILITY_DEPRAVITY', 'ABILITY_OVERCHARGE', 'ABILITY_PYROCLASTIC_FLOW', 'ABILITY_TRASH_HEAP', 'ABILITY_TUMMYACHE']),
    )
  })

  it('deleting the two Tummyache lines drops it; the control keeps it', () => {
    expect(PORTED_CAN_STATUS_TYPE_ABILITIES.has('ABILITY_TUMMYACHE')).toBe(true)
    // Two lines carry the literal: the CanPoisonType bypass-array entry (statusEffects.ts:615) and
    // the `CAN_STATUS_TYPE_ABILITIES` census list (:238). There is no CanParalyzeType entry.
    const mutated = dropLinesContaining(statusEffectsSource, "'ABILITY_TUMMYACHE',")
    expect(extractCanStatusTypeAbilities(mutated).has('ABILITY_TUMMYACHE')).toBe(false)
    expect(extractCanStatusTypeAbilities(statusEffectsSource).has('ABILITY_TUMMYACHE')).toBe(true)
  })

  it('a made-up id is evidence only inside a CanXType bypass array, and the classifier follows it', () => {
    const fabricated = 'ABILITY_SYNTHETIC_CAN_STATUS'
    const fabricatedData: Record<string, AbilityHookRecord> = {
      [fabricated]: { id: fabricated, sourceLine: 1, hooks: { onCanStatusType: { form: 'lambda' } } },
    }

    // Outside both function slices a literal is not evidence: the slices end at the next declaration.
    const outside = `${statusEffectsSource}\nconst SYNTHETIC_CAN_STATUS = '${fabricated}'\n`
    expect(extractCanStatusTypeAbilities(outside).has(fabricated)).toBe(false)

    // A real bypass-array entry inside canPoisonType is evidence the extractor sees.
    const inArray = statusEffectsSource.replace(
      "    'ABILITY_TUMMYACHE',\n  ]) {",
      `    'ABILITY_TUMMYACHE',\n    '${fabricated}',\n  ]) {`,
    )
    expect(inArray).not.toBe(statusEffectsSource)
    expect(extractCanStatusTypeAbilities(inArray).has(fabricated)).toBe(true)

    // The classifier reads the evidence set, so with no entry it is unported even though the hook
    // data defines the pair.
    expect(isDirectlyPorted(fabricated, 'onCanStatusType')).toBe(false)
    expect(classifyPair(fabricated, 'onCanStatusType', fabricatedData)).toBe('unported')

    // Control: once the extractor supplies a real branch, the same pair is ported.
    PORTED_CAN_STATUS_TYPE_ABILITIES.add(fabricated)
    try {
      expect(isDirectlyPorted(fabricated, 'onCanStatusType')).toBe(true)
      expect(classifyPair(fabricated, 'onCanStatusType', fabricatedData)).toBe('ported')
    } finally {
      PORTED_CAN_STATUS_TYPE_ABILITIES.delete(fabricated)
    }
  })
})

// ---------------------------------------------------------------------------
// (3b) onModifyEffectChance reads the comparisons in getMoveEffectChance.
// ---------------------------------------------------------------------------

describe('Cycle 150g (3b) - onModifyEffectChance comes from getMoveEffectChance comparisons', () => {
  it('extracts the same 13 ids the census list holds', () => {
    const extracted = extractModifyEffectChanceAbilities(statusEffectsSource)
    expect(extracted).toEqual(PORTED_MODIFY_EFFECT_CHANCE_ABILITIES)
    expect([...extracted].sort()).toEqual(definedFor('onModifyEffectChance'))
    expect(extracted.size).toBe(13)
  })

  it('deleting the Thermomancy comparison drops it; the control keeps it', () => {
    expect(PORTED_MODIFY_EFFECT_CHANCE_ABILITIES.has('ABILITY_THERMOMANCY')).toBe(true)
    const mutated = dropLineContaining(statusEffectsSource, "abilityId === 'ABILITY_THERMOMANCY'")
    expect(extractModifyEffectChanceAbilities(mutated).has('ABILITY_THERMOMANCY')).toBe(false)
    expect(extractModifyEffectChanceAbilities(statusEffectsSource).has('ABILITY_THERMOMANCY')).toBe(true)
  })

  it('a made-up id is evidence only as a positive equality comparison, and the classifier follows it', () => {
    const fabricated = 'ABILITY_SYNTHETIC_EFFECT_CHANCE'
    const fabricatedData: Record<string, AbilityHookRecord> = {
      [fabricated]: { id: fabricated, sourceLine: 1, hooks: { onModifyEffectChance: { form: 'lambda' } } },
    }

    // A real positive comparison in the dispatch body is evidence.
    const realBranch = statusEffectsSource.replace(
      "        } else if (abilityId === 'ABILITY_THERMOMANCY') {",
      `        } else if (abilityId === '${fabricated}') {\n          chance *= 3\n        } else if (abilityId === 'ABILITY_THERMOMANCY') {`,
    )
    expect(realBranch).not.toBe(statusEffectsSource)
    expect(extractModifyEffectChanceAbilities(realBranch).has(fabricated)).toBe(true)

    // An inequality sits outside a real branch: extractComparedAbilityLiterals documents it as no
    // evidence (the same rule that keeps Trace unported), so the extractor does not see it.
    const inequality = statusEffectsSource.replace(
      '      if (isAttacker) {',
      `      if (isAttacker && abilityId !== '${fabricated}') {`,
    )
    expect(inequality).not.toBe(statusEffectsSource)
    expect(extractModifyEffectChanceAbilities(inequality).has(fabricated)).toBe(false)

    // The classifier reads the evidence set, so with no entry it is unported.
    expect(isDirectlyPorted(fabricated, 'onModifyEffectChance')).toBe(false)
    expect(classifyPair(fabricated, 'onModifyEffectChance', fabricatedData)).toBe('unported')

    // Control: once the extractor supplies a real branch, the same pair is ported.
    PORTED_MODIFY_EFFECT_CHANCE_ABILITIES.add(fabricated)
    try {
      expect(isDirectlyPorted(fabricated, 'onModifyEffectChance')).toBe(true)
      expect(classifyPair(fabricated, 'onModifyEffectChance', fabricatedData)).toBe('ported')
    } finally {
      PORTED_MODIFY_EFFECT_CHANCE_ABILITIES.delete(fabricated)
    }
  })
})

// ---------------------------------------------------------------------------
// (3c) onReactive reads runReactiveAbilityEffects plus the clone dispatcher set.
// ---------------------------------------------------------------------------

describe('Cycle 150g (3c) - onReactive comes from the reactive dispatcher', () => {
  it('extracts the dispatcher comparisons plus the clone set members that have a case label', () => {
    const extracted = extractReactiveAbilities(statBuffsSource)
    expect(extracted).toEqual(PORTED_REACTIVE_ABILITIES)
    // The clone set only reaches a port through a case label (cycle 150i): the seven handled
    // members are in, and the two note-only members (Frostbind, Hemotoxin) are not -- their only
    // site is the `abilityId ===` branch that pushes a note, and NOTE_ONLY_SET removes them from
    // the ported count anyway.
    const caseHandled = [...POISON_PUPPETEER_CLONE_ABILITIES].filter(
      (id) => !['ABILITY_FROSTBIND', 'ABILITY_HEMOTOXIN'].includes(id),
    )
    expect(caseHandled).toHaveLength(7)
    for (const id of caseHandled) {
      expect(extracted.has(id), `${id} has a case label in runPoisonPuppeteerClone`).toBe(true)
    }
    expect(extracted.has('ABILITY_FROSTBIND'), 'note-only, no case label').toBe(false)
    expect(extracted.has('ABILITY_HEMOTOXIN'), 'note-only, no case label').toBe(false)
    expect(NOTE_ONLY_SET.has('ABILITY_FROSTBIND:onReactive')).toBe(true)
    expect(NOTE_ONLY_SET.has('ABILITY_HEMOTOXIN:onReactive')).toBe(true)
    expect(isDirectlyPorted('ABILITY_FROSTBIND', 'onReactive')).toBe(false)
    expect(isDirectlyPorted('ABILITY_HEMOTOXIN', 'onReactive')).toBe(false)
    expect(isDirectlyPorted('ABILITY_NEUROTOXIN', 'onReactive')).toBe(true)
  })

  it('deleting the Acid Reflux comparison branch drops it; the control keeps it', () => {
    expect(PORTED_REACTIVE_ABILITIES.has('ABILITY_ACID_REFLUX')).toBe(true)
    const mutated = removeBranch(statBuffsSource, "abilityId === 'ABILITY_ACID_REFLUX'")
    expect(extractReactiveAbilities(mutated).has('ABILITY_ACID_REFLUX')).toBe(false)
    expect(extractReactiveAbilities(statBuffsSource).has('ABILITY_ACID_REFLUX')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (4) onAttacker / onDefender need a real branch in their handler.
// ---------------------------------------------------------------------------

describe('Cycle 150g (4) - move-end pairs need a branch, not just a pinned-list entry', () => {
  it('every listed attacker and defender pair has branch evidence (0 listed with no branch)', () => {
    expect(extractAttackerBranchAbilities(moveEndSource)).toEqual(PORTED_ATTACKER_BRANCH_ABILITIES)
    expect(extractDefenderBranchAbilities(moveEndSource)).toEqual(PORTED_DEFENDER_BRANCH_ABILITIES)
    expect([...PORTED_ATTACKER_ABILITIES].filter((id) => !PORTED_ATTACKER_BRANCH_ABILITIES.has(id))).toEqual([])
    expect([...PORTED_DEFENDER_ABILITIES].filter((id) => !PORTED_DEFENDER_BRANCH_ABILITIES.has(id))).toEqual([])
  })

  it('deleting the attacker Resonance branch drops it; the control keeps it', () => {
    expect(PORTED_ATTACKER_BRANCH_ABILITIES.has('ABILITY_RESONANCE')).toBe(true)
    const mutated = removeBranch(moveEndSource, "if (abilityId === 'ABILITY_RESONANCE') {")
    expect(extractAttackerBranchAbilities(mutated).has('ABILITY_RESONANCE')).toBe(false)
    expect(extractAttackerBranchAbilities(moveEndSource).has('ABILITY_RESONANCE')).toBe(true)
  })

  it('deleting the defender Soul Linker branch drops it; the control keeps it', () => {
    expect(PORTED_DEFENDER_BRANCH_ABILITIES.has('ABILITY_SOUL_LINKER')).toBe(true)
    const mutated = removeBranch(moveEndSource, "if (abilityId === 'ABILITY_SOUL_LINKER') {")
    expect(extractDefenderBranchAbilities(mutated).has('ABILITY_SOUL_LINKER')).toBe(false)
    expect(extractDefenderBranchAbilities(moveEndSource).has('ABILITY_SOUL_LINKER')).toBe(true)
  })

  it('deleting the Hydrate key from ATE_ON_HIT_STATUS drops it from the attacker set', () => {
    expect(PORTED_ATTACKER_BRANCH_ABILITIES.has('ABILITY_HYDRATE')).toBe(true)
    const mutated = dropLineContaining(moveEndSource, "ABILITY_HYDRATE: { type: 'WATER'")
    // Hydrate is reached only through the keyed table, not an equality comparison.
    expect(extractAttackerBranchAbilities(mutated).has('ABILITY_HYDRATE')).toBe(false)
    expect(extractAttackerBranchAbilities(moveEndSource).has('ABILITY_HYDRATE')).toBe(true)
  })

  it('a fabricated id inserted into the pinned attacker set but with no branch is unported', () => {
    const fabricated = 'ABILITY_SYNTHETIC_ATTACKER_BRANCH'
    const fabricatedData: Record<string, AbilityHookRecord> = {
      [fabricated]: { id: fabricated, sourceLine: 1, hooks: { onAttacker: { form: 'lambda' } } },
    }
    expect(isDirectlyPorted(fabricated, 'onAttacker')).toBe(false)
    PORTED_ATTACKER_ABILITIES.add(fabricated)
    try {
      expect(PORTED_ATTACKER_ABILITIES.has(fabricated)).toBe(true)
      expect(isDirectlyPorted(fabricated, 'onAttacker'), 'pinned but no branch').toBe(false)
      expect(classifyPair(fabricated, 'onAttacker', fabricatedData)).toBe('unported')
    } finally {
      PORTED_ATTACKER_ABILITIES.delete(fabricated)
    }
  })
})

// ---------------------------------------------------------------------------
// (6a) onRecoil reads the two MOVEEND_RECOIL tables.
// ---------------------------------------------------------------------------

describe('Cycle 150g (6a) - onRecoil comes from ON_RECOIL_TYPES intersect ON_RECOIL_DIVISORS', () => {
  it('extracts the five ids present in both tables and in the loop gate list', () => {
    const extracted = extractRecoilAbilities(moveEndSource)
    expect(extracted).toEqual(PORTED_RECOIL_ABILITIES_SET)
    expect([...extracted].sort()).toEqual([...ON_RECOIL_ABILITIES].sort())
    expect(extracted.size).toBe(5)
  })

  it('deleting the Doom Blast divisor drops it; the control keeps it', () => {
    expect(PORTED_RECOIL_ABILITIES_SET.has('ABILITY_DOOM_BLAST')).toBe(true)
    const mutated = dropLineContaining(moveEndSource, 'ABILITY_DOOM_BLAST: 20,')
    expect(extractRecoilAbilities(mutated).has('ABILITY_DOOM_BLAST')).toBe(false)
    expect(extractRecoilAbilities(moveEndSource).has('ABILITY_DOOM_BLAST')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (6b) onModifyMoveFlags reads returning-true flag-predicate branches.
// ---------------------------------------------------------------------------

describe('Cycle 150g (6b) - onModifyMoveFlags comes from flag predicates', () => {
  it('the five predicates find exactly the abilities the C says they grant', () => {
    expect([...extractMoveFlagPredicateAbilities(statusEffectsSource, 'export function isSoundMove(')].sort()).toEqual([
      'ABILITY_FESTIVITIES',
      'ABILITY_MUSICAL_NOTES',
      'ABILITY_REVERBATE',
    ])
    expect([...extractMoveFlagPredicateAbilities(statusEffectsSource, 'export function isKeenEdgeMove(')]).toEqual([
      'ABILITY_CHESTNUT_AXE',
    ])
    expect([...extractMoveFlagPredicateAbilities(statusEffectsSource, 'export function isStrikerMove(')].sort()).toEqual([
      'ABILITY_BACKSTREET_BOY',
      'ABILITY_JUNSHI_SANDA',
      'ABILITY_MIXED_MARTIAL_ARTS',
    ])
    expect([...extractMoveFlagPredicateAbilities(moveEndSource, 'export function isDanceMove(')].sort()).toEqual([
      'ABILITY_BACKSTREET_BOY',
      'ABILITY_FESTIVITIES',
      'ABILITY_TAEKKYEON',
    ])
    expect([...extractMoveFlagPredicateAbilities(moveTargetFlagsSource, 'export function isMegaLauncherBoostedMove(')]).toEqual([
      'ABILITY_GUNMAN',
    ])
  })

  it('no hook is ported while no consumer family is wired', () => {
    // Cycle 150i: MOVE_FLAG_CONSUMERS_WIRED is empty, so a returning-true predicate branch alone
    // does not make a port. All 10 pairs stay unported until the consumers read the predicates.
    const extracted = extractModifyMoveFlagsAbilities()
    expect(extracted).toEqual(PORTED_MODIFY_MOVE_FLAGS_ABILITIES)
    expect(extracted.size).toBe(0)
    for (const id of definedFor('onModifyMoveFlags')) {
      expect(isDirectlyPorted(id, 'onModifyMoveFlags'), `${id} has no wired consumer`).toBe(false)
    }
  })

  it('leaves the PUNCH-granting hooks unported: the sim has no PUNCH predicate', () => {
    for (const id of ['ABILITY_BRAWLING_WYVERN', 'ABILITY_JUNSHI_SANDA', 'ABILITY_MIXED_MARTIAL_ARTS']) {
      expect(isDirectlyPorted(id, 'onModifyMoveFlags'), `${id} grants PUNCH`).toBe(false)
    }
    // Junshi Sanda and Mixed Martial Arts do have the KICK half; PUNCH alone would keep them out of
    // any wired port (today every pair is unported anyway, because no consumer family is wired).
    expect(extractMoveFlagPredicateAbilities(statusEffectsSource, 'export function isStrikerMove(').has('ABILITY_JUNSHI_SANDA')).toBe(true)
    expect(extractMoveFlagPredicateAbilities(statusEffectsSource, 'export function isStrikerMove(').has('ABILITY_MIXED_MARTIAL_ARTS')).toBe(true)
  })

  it('Reverbate and Mixed Martial Arts compare the loader-normalised bare type, not the raw TYPE_ spelling', () => {
    // abilities.cc:10657-10662 CHECKs gBattleMoves[move].type == TYPE_NORMAL; :9898-9905 does the
    // same for Mixed Martial Arts. The sim sees the type after loadSimData.ts:188,214 has stripped
    // the prefix (String(m.type).replace('TYPE_', '')), so the bare 'NORMAL' comparison is live.
    const moveTypes = new Set(rawMoves.map((m) => String(m.type)))
    expect([...moveTypes].every((type) => type.startsWith('TYPE_'))).toBe(true)
    const normalised = new Set([...moveTypes].map((type) => type.replace('TYPE_', '')))
    expect(normalised.has('NORMAL')).toBe(true)
    expect(normalised.has('TYPE_NORMAL')).toBe(false)

    // Reverbate (isSoundMove) and Mixed Martial Arts (isStrikerMove) both use the bare spelling.
    const comparisons = ['export function isSoundMove(', 'export function isStrikerMove('].map((declaration) => {
      const slice = extractFunctionSlice(statusEffectsSource, declaration)
      expect(slice).toContain("moveData?.type === 'NORMAL'")
      return slice.match(/moveData\?\.type === 'NORMAL'/g)?.length ?? 0
    })
    expect(comparisons.reduce((acc, n) => acc + n, 0)).toBeGreaterThanOrEqual(2)
  })

  it('deleting the Musical Notes branch from isSoundMove makes it unported; the control keeps it', () => {
    // The wired list is passed explicitly: with the shipped empty MOVE_FLAG_CONSUMERS_WIRED every
    // pair is unported regardless of its branch, so the branch-vs-no-branch difference is only
    // observable for the family a later cycle wires.
    const wired: readonly MoveFlagFamily[] = ['sound']
    expect(extractModifyMoveFlagsAbilities({}, wired).has('ABILITY_MUSICAL_NOTES')).toBe(true)
    const mutated = removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_MUSICAL_NOTES'")
    expect(extractModifyMoveFlagsAbilities({ statusEffects: mutated }, wired).has('ABILITY_MUSICAL_NOTES')).toBe(false)
    expect(extractModifyMoveFlagsAbilities({ statusEffects: statusEffectsSource }, wired).has('ABILITY_MUSICAL_NOTES')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Real-output pins and the generated doc.
// ---------------------------------------------------------------------------

describe('Cycle 150g - real inventory counts for the six hook kinds', () => {
  const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
  const result = runInventory(abilityHooks, mentioned, ABILITY_HOOK_ALLOWLIST)
  const summary = (hook: string) => result.summaries.find((s) => s.hook === hook)!

  const expected: Array<[string, number, number, number]> = [
    // hook, defined, ported, unported
    ['onAttacker', 144, 139, 5],
    ['onDefender', 122, 122, 0],
    ['onCanStatusType', 8, 8, 0],
    ['onModifyEffectChance', 13, 13, 0],
    ['onReactive', 18, 10, 8],
    ['onRecoil', 5, 5, 0],
    ['onModifyMoveFlags', 10, 0, 10],
  ]

  for (const [hook, defined, ported, unported] of expected) {
    it(`${hook}: ${defined} defined / ${ported} ported / ${unported} unported`, () => {
      const s = summary(hook)
      expect({ defined: s.defined, ported: s.ported, unported: s.unported }).toEqual({ defined, ported, unported })
    })
  }

  it('total unported is 72: all 10 onModifyMoveFlags pairs are unported again', () => {
    // Cycle 150g had 65 because seven flag-predicate branches counted as ports. Cycle 150i reverts
    // that: the consumers still read the static flags, so the 150b/150f total of 72 is correct.
    expect(result.totalUnported).toBe(72)
    const unported = result.unportedPairs.filter((p) => p.hook === 'onModifyMoveFlags').map((p) => p.ability).sort()
    expect(unported).toEqual(definedFor('onModifyMoveFlags'))
    expect(unported).toHaveLength(10)
  })

  it('the generated inventory doc equals the committed docs/battle-sim/ability-hook-inventory.md', () => {
    const generated = generateInventoryDoc(result, abilityHooks)
    expect(readFileSync(DOC_PATH, 'utf8')).toBe(generated)
  })
})
