// Batch AS: the onPriority family -- the first NON-damage hook in this registry.
//
// These do not change a damage number. GetMovePriority (src/battle_main.c:4264)
// sums them into the move's priority, which the packed turn-order word
// (engine/sim/turnOrder.ts) carries at bits 20-23. See OnPriorityContext for why
// they live in this registry rather than a parallel one.
//
// Population, and why THIS population. Three numbers, each sizing something
// different, all re-measured against data/v2.65beta:
//
//   19 of 1016  abilities declare an onPriority hook at all. That is what the
//               hook type has to cover, and it is the list REMAINING_ON_PRIORITY
//               below enumerates the rest of.
//   9           are fielded by the 40 Elite-difficulty boss fights the solver
//               targets (docs/battle-sim/boss-fight-coverage.md), counting the
//               chosen ability plus all three species innates. Those 9 are
//               ported here.
//   8           of those 9 are NEW registry entries; Perfectionist already had
//               one for its onCrit hook (batch O), so its onPriority is added
//               there instead of here. 8 and 9 are different predicates, not
//               disagreeing counts.
//
// The other 10 are left as data, not prose -- REMAINING_ON_PRIORITY at the
// bottom. Eight of them are the same GALE_WINGS_CLONE macro this file already
// implements and are a one-line change each once someone wants them.
//
// TURN-ORDER ABILITIES THAT ARE NOT HERE, because onPriority is not the only way
// an ability reaches turn order:
//
//   ABILITY_QUICK_DRAW is checked BY NAME in SetActionsAndBattlersTurnOrder
//     (src/battle_main.c:4407) and sets gRoundStructs[].quickDraw, which packs
//     into `goesFirst` at bits 18-19 -- a HIGHER field than priority, so it is
//     not interchangeable with a priority bonus. It has no hook lambda at all
//     and is absent from abilityHooks.json entirely, so no scan of onPriority
//     can ever find it. Measured: the only species carrying it are
//     SPECIES_SLOWBRO_GALARIAN and SPECIES_SLOWBRO_MEGA_GALARIAN, and the only
//     boss party fielding either is TRAINER_TATE_AND_LIZA_1 -- in its ACE tier,
//     not Elite, so it is out of the solver's target set. Reachable only if Ace
//     comes off the backlog.
//   ABILITY_QUICK_FEET exempts its holder from the paralysis speed drop
//     (src/battle_main.c:4185), another by-name check. It is fielded on 1 Elite
//     slot and is already a seam on TurnOrderContext (hasQuickFeet).

import type { AbilityImpl } from '../types'

/** GALE_WINGS_CLONE(type), src/abilities.cc:126-131:
 *
 *     CHECK(GetTypeBeforeUsingMove(move, battler) == type)
 *     CHECK(BATTLER_MAX_HP(battler))
 *     return 1;
 *
 * Both CHECKs must pass. `BATTLER_MAX_HP` is include/battle.h:749, hp == maxHP,
 * so a single point of chip damage turns the whole family off. */
function galeWingsClone(type: string): AbilityImpl['onPriority'] {
  return (ctx) => (ctx.moveType === type && ctx.holderAtMaxHp ? 1 : 0)
}

export const PRIORITY_ABILITIES: AbilityImpl[] = [
  {
    // The Gale Wings family: eight abilities, one macro, differing only in type.
    id: 'ABILITY_GALE_WINGS',
    src: 'src/abilities.cc:2433',
    onPriority: galeWingsClone('FLYING'),
  },
  {
    id: 'ABILITY_WATER_GALE_WINGS',
    src: 'src/abilities.cc:7120',
    onPriority: galeWingsClone('WATER'),
  },
  {
    id: 'ABILITY_FLAMING_SOUL',
    src: 'src/abilities.cc:4522',
    onPriority: galeWingsClone('FIRE'),
  },
  {
    id: 'ABILITY_VOLT_RUSH',
    src: 'src/abilities.cc:5454',
    onPriority: galeWingsClone('ELECTRIC'),
  },
  {
    // CHECK(IS_MOVE_STATUS(move)) return 1. No HP gate, no type gate -- the
    // simplest of the nine, and the one whose NAME matches its behaviour.
    id: 'ABILITY_PRANKSTER',
    src: 'src/abilities.cc:2244',
    onPriority: (ctx) => (ctx.isStatus ? 1 : 0),
  },
  {
    // CHECK(gBattleMons[target].hp <= gBattleMons[target].maxHP / 2) return 1.
    //
    // Reads the TARGET's HP, not the holder's -- the only one of the nine that
    // depends on someone else's state, and the reason OnPriorityContext carries
    // the target's HP at all. `maxHP / 2` is integer division in the C, so the
    // threshold rounds DOWN on an odd max HP; divided the same way here rather
    // than compared as a float ratio.
    id: 'ABILITY_OPPORTUNIST',
    src: 'src/abilities.cc:4665',
    onPriority: (ctx) => {
      if (ctx.targetHp === null || ctx.targetMaxHp === null) return 0
      return ctx.targetHp <= Math.trunc(ctx.targetMaxHp / 2) ? 1 : 0
    },
  },
  {
    // CHECK(IsIronFistBoosted(battler, move)) CHECK(BATTLER_MAX_HP(battler)).
    // IsIronFistBoosted is src/battle_util.c:9375, DoesMoveMatchFlag(..,
    // MOVE_FLAG_PUNCH) -- already ported as dispatchCalc's isIronFistBoosted and
    // resolved against the HOLDER's own slots by the dispatcher, since an
    // ability can grant the punch flag. Reading it off ctx rather than calling
    // it here is what makes that possible.
    id: 'ABILITY_BLITZ_BOXER',
    src: 'src/abilities.cc:3725',
    onPriority: (ctx) => (ctx.isIronFistBoosted && ctx.holderAtMaxHp ? 1 : 0),
  },
  {
    // CHECK(move == MOVE_ROAR_OF_TIME)
    // return -gBattleMoves[MOVE_ROAR_OF_TIME].priority;
    //
    // The return is the NEGATION of Roar of Time's own declared priority, so it
    // cancels it: Roar of Time is priority -6 in this build, the ability returns
    // +6, and the move resolves at 0 rather than at +6. A reading of the name
    // alone ("rupture time") would suggest a speed boost; it is a penalty
    // removal.
    //
    // The C indexes MOVE_ROAR_OF_TIME explicitly rather than using the move in
    // hand, but the CHECK above guarantees they are the same move, so
    // ctx.movePriority is the same value.
    id: 'ABILITY_TEMPORAL_RUPTURE',
    src: 'src/abilities.cc:10043',
    onPriority: (ctx) => (ctx.moveId === 'MOVE_ROAR_OF_TIME' ? -ctx.movePriority : 0),
  },
]

/** The 10 onPriority abilities not ported, because no Elite-tier party in the 40
 * boss fights fields them. Data rather than a comment so it can be iterated,
 * diffed and counted -- priorityCoverage.test.ts asserts this list plus the
 * ported ones accounts for every onPriority ability in abilityHooks.json, so it
 * cannot silently drift out of date.
 *
 * `needs` names what is missing beyond a registry entry. Eight of the ten need
 * nothing at all: they are GALE_WINGS_CLONE with a different type and are one
 * call to galeWingsClone() each. */
export const REMAINING_ON_PRIORITY: { id: string; src: string; needs: string }[] = [
  { id: 'ABILITY_CUTE_ANTECEDENCE', src: 'src/abilities.cc:7891', needs: "nothing -- galeWingsClone('FAIRY')" },
  { id: 'ABILITY_DARK_GALE_WINGS', src: 'src/abilities.cc:7103', needs: "nothing -- galeWingsClone('DARK')" },
  { id: 'ABILITY_EARLY_GRAVE', src: 'src/abilities.cc:6651', needs: "nothing -- galeWingsClone('GHOST')" },
  { id: 'ABILITY_FROZEN_SOUL', src: 'src/abilities.cc:4614', needs: "nothing -- galeWingsClone('ICE')" },
  {
    id: 'ABILITY_GALEFORCE_WINGS',
    src: 'src/abilities.cc:11251',
    needs: 'nothing -- the Gale Wings shape WITHOUT the max-HP gate (Flying only, one CHECK)',
  },
  {
    id: 'ABILITY_FLAME_BUBBLE',
    src: 'src/abilities.cc:8278',
    needs: 'nothing -- aliases Flaming Soul onPriority; add to its EXISTING damage-relevant entry, not here',
  },
  {
    id: 'ABILITY_IRON_BARRAGE',
    src: 'src/abilities.cc:4992',
    needs: 'Sighting System first -- aliases its onPriority; also already has a damage-relevant entry',
  },
  {
    id: 'ABILITY_SIGHTING_SYSTEM',
    src: 'src/abilities.cc:4650',
    needs: "MoveData.accuracy, which the engine does not emit -- the hook is `CHECK(accuracy) CHECK(accuracy < 80) return -3`, and note it is a PENALTY, not a boost",
  },
  {
    id: 'ABILITY_PRESTO',
    src: 'src/abilities.cc:9397',
    needs: 'an IsSoundMove predicate (max-HP gate plus a sound-flag check that abilities can grant, same shape as isIronFistBoosted)',
  },
  {
    id: 'ABILITY_TRIAGE',
    src: 'src/abilities.cc:2803',
    needs: 'an IsHealingMoveEffect predicate over the move effect list; returns +3, the largest delta in the family',
  },
]
