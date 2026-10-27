// The hand-written damaging scripts of data/battle_scripts_1.s that wrap an ordinary hit in a check before it or an extra after it.
// MoveBehaviorConfigList.textproto maps each of these effects to its `legacy_config` script; the plain-`BattleScript_EffectHit` ones
// need nothing here (the damage engine carries their rule), these do.
//
//   before the hit (runLegacyPreHit)  -- between ppreduce and accuracycheck:
//     Poltergeist :307-315, Last Resort :1904-1910, Snore :4709-4726, Natural Gift :3046-3071, Fling :3036-3044,
//     Belch / Berry Smash :3073-3088, Nightmare :4909-4914 (BattleScript_EffectNightmare, before attackcanceler).
//   after the hit (runLegacyPostHit)  -- after seteffectwithchance / tryfaintmon, before moveendall:
//     the weather / terrain / Tailwind / screen setters (:3426-3464, :497-560), Sparkly Swirl :422, Smelling Salts :3384, Eerie Spell
//     :4796, Plasma Fists :397, Ghastly Echo :2793, Natural Gift's item removal :3065-3069, Clear Weather and Terrain Hit :685,
//     Remove Terrain No Fail :717.

import type { BattleState } from './state'
import type { StatChangeOutcome, TurnLoopDeps } from './turn'
import {
  ENUM_WEATHER_RAIN,
  ENUM_WEATHER_SANDSTORM,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STATUS1_ANY,
  STATUS1_SLEEP,
  STATUS2_NIGHTMARE,
  STATUS3_EMBARGO,
  STATUS3_SEMI_INVULNERABLE,
  STATUS4_PLASMA_FISTS,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TERRAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_STRONG_WINDS,
  WEATHER_SUN_PRIMAL,
  clearFlag,
  hasFlag,
  setFlag,
} from './constants'
import { battlerHasSimAbility } from './statBuffs'
import {
  canBattlerGetOrLoseItem,
  clearBattlerItem,
  consumeBerryWithOverride,
  hasNonNegatedBerry,
  setFieldTerrain,
  startTailwind,
} from './moveEffects'
import { tryChangeBattleWeather } from './switchInAbility'
import { dispatchOnTerrainChange, dispatchOnWeatherChange } from './onWeather'
import { cancelMultiTurnMoves } from './statusEffects'

export interface LegacyPreHitArgs {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  moveEffect: string
  deps: TurnLoopDeps
  unmodelled: string[]
  /** Cmd_ppreduce, for the one script that reaches it twice (Belch / Berry Smash). */
  deductPp: () => void
}

export interface LegacyPreHitResult {
  /** The script jumps to BattleScript_ButItFailed. */
  fail: boolean
  /** Whether the failing path still runs ppreduce (Nightmare fails before it). */
  deductPpOnFail: boolean
  /** Stat changes made on the way (a berry eaten by Belch / Berry Smash). */
  statChanges: StatChangeOutcome[]
  /** gBattlerTarget is replaced (Shell Trap aims at whoever hit the user). */
  retarget?: number
}

/**
 * CanUseLastResort, battle_script_commands.c:6481-6491, ported as written. Its comment says every other slot must have been used, but
 * the body is `FILTER(move) FILTER(effect == EFFECT_LAST_RESORT) FILTER(usedMoves & bit) return FALSE`, and FILTER is `if (!x) continue`:
 * it returns FALSE exactly when a Last Resort slot has ALREADY been used, and TRUE otherwise whatever the other slots hold.
 */
function canUseLastResort(state: BattleState, attackerId: number, deps: TurnLoopDeps): boolean {
  const attacker = state.battlers[attackerId]
  if (!attacker) return false
  for (let i = 0; i < attacker.mon.moves.length; i++) {
    const move = attacker.mon.moves[i]
    if (!move) continue
    if (deps.dataContext.move(move)?.effect !== 'EFFECT_LAST_RESORT') continue
    if (!(attacker.volatiles.usedMoves & (1 << i))) continue
    return false
  }
  return true
}

/**
 * The checks these scripts make between `ppreduce` and the hit. Returns null for an effect it has nothing to say about.
 */
export function runLegacyPreHit(args: LegacyPreHitArgs): LegacyPreHitResult | null {
  const { state, attackerId, targetId, moveId, moveEffect, deps, unmodelled } = args
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target) return null
  const pass: LegacyPreHitResult = { fail: false, deductPpOnFail: true, statChanges: [] }
  const fail: LegacyPreHitResult = { fail: true, deductPpOnFail: true, statChanges: [] }

  switch (moveEffect) {
    case 'EFFECT_POLTERGEIST':
      // VARIOUS_CHECK_POLTERGEIST, battle_script_commands.c:8117-8125.
      if (
        !target.mon.itemId ||
        hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE) ||
        battlerHasSimAbility(state, target, 'ABILITY_KLUTZ', false, attackerId, false, deps.dataContext)
      ) {
        return fail
      }
      return pass

    case 'EFFECT_LAST_RESORT':
      // VARIOUS_TRY_LAST_RESORT, :7515-7518.
      return canUseLastResort(state, attackerId, deps) ? pass : fail

    case 'EFFECT_SNORE':
      // BattleScript_EffectSnore :4709-4726: asleep or Comatose, else `attackstring; ppreduce; ButItFailed`.
      if (hasFlag(attacker.mon.status1, STATUS1_SLEEP) || battlerHasSimAbility(state, attacker, 'ABILITY_COMATOSE', true, attackerId, false, deps.dataContext)) {
        return pass
      }
      return fail

    case 'EFFECT_NATURAL_GIFT':
      // jumpifnotberry BS_ATTACKER, BattleScript_ButItFailed (:3050); VARIOUS_JUMP_IF_NOT_BERRY :6869-6875.
      return hasNonNegatedBerry(state, attackerId, deps) ? pass : fail

    case 'EFFECT_FLING': {
      // VARIOUS_TRY_FLING, :8402-8433. CanFling, battle_util.c:8414-8420. The item leaves the slot now; its id is kept in
      // gTurnStructs[].flungItem for the damage (Iron Ball / Big Nugget power, a Gem's type) and for the effect it sets.
      const itemId = attacker.mon.itemId
      const negated = hasFlag(attacker.statuses3, STATUS3_EMBARGO) || battlerHasSimAbility(state, attacker, 'ABILITY_KLUTZ', false, attackerId, false, deps.dataContext)
      if (!itemId || negated || !canBattlerGetOrLoseItem(attacker, itemId, deps)) {
        attacker.turn.flungItem = null
        return fail
      }
      attacker.turn.flungItem = itemId
      clearBattlerItem(state, attacker, unmodelled)
      return pass
    }

    case 'EFFECT_BELCH':
    case 'EFFECT_BERRY_SMASH': {
      // BattleScript_EffectBerrySmash :3073-3088. No (usable) berry: `setmoveeffect 0; goto BattleScript_EffectHit`, a plain hit.
      if (!hasNonNegatedBerry(state, attackerId, deps)) return null
      // attackcanceler / attackstring / ppreduce, then sBERRY_OVERRIDE and consumeberry; the script then rejoins at
      // BattleScript_HitFromAccCheck, whose own ppreduce is a SECOND deduction (Cmd_ppreduce has no already-deducted state).
      args.deductPp()
      const statChanges: StatChangeOutcome[] = []
      consumeBerryWithOverride(state, attackerId, attackerId, moveId, deps, unmodelled, statChanges)
      // Belch only: `jumpifnotmove MOVE_BELCH, HitFromAccCheck; jumpifnotberry BS_ATTACKER, HitFromAccCheck; goto ButItFailed` -- a
      // berry still held after eating (the eaten one did nothing, e.g. at full HP) makes Belch fail.
      if (moveId === 'MOVE_BELCH' && hasNonNegatedBerry(state, attackerId, deps)) {
        return { fail: true, deductPpOnFail: false, statChanges }
      }
      return { fail: false, deductPpOnFail: true, statChanges }
    }

    case 'EFFECT_NIGHTMARE':
      // BattleScript_EffectNightmare :4909-4914 -- no attackcanceler / ppreduce before this check, so the failing path spends no PP.
      if (hasFlag(target.mon.status1, STATUS1_SLEEP) || battlerHasSimAbility(state, target, 'ABILITY_COMATOSE', true, attackerId, false, deps.dataContext)) {
        return pass
      }
      return { fail: true, deductPpOnFail: false, statChanges: [] }

    case 'EFFECT_SHELL_TRAP': {
      // BattleScript_EffectShellTrap (s:4672-4676) -> VARIOUS_SHELL_TRAP_CHOICE, battle_script_commands.c:8905-8915 (`shelltraptarget
      // BattleScript_ButItFailedAtkStringPpReduce`). REQUIRE_NOT(multiHitsUsed) is a bare `break` (global.h:56-57): the script carries on
      // untouched. Otherwise the move needs a physical hit from the other side this turn by a battler that is still alive, and that
      // battler becomes the target; any other case jumps to the failure.
      if (attacker.turn.multiHitsUsed) return pass
      const hitBy = attacker.round.physicalBattlerId
      const wasHit = attacker.round.physicalDmg > 0 && (hitBy & 1) !== (attackerId & 1) && (state.battlers[hitBy]?.mon.hp ?? 0) > 0
      return wasHit ? { ...pass, retarget: hitBy } : fail
    }

    default:
      return null
  }
}

export interface LegacyPostHitArgs {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  moveEffect: string | null
  /** What the hit did to the target (0 = type-immune / no effect, null = unresolved). */
  targetDamage: number | null
  deps: TurnLoopDeps
  unmodelled: string[]
}

/** VARIOUS_REMOVE_WEATHER, battle_script_commands.c:7938-7959: primal weather and Delta Stream's winds cannot be ended; anything else is cleared. */
function removeWeather(args: LegacyPostHitArgs): void {
  const field = args.state.field
  if (hasFlag(field.weather, WEATHER_SUN_PRIMAL) || hasFlag(field.weather, WEATHER_RAIN_PRIMAL) || hasFlag(field.weather, WEATHER_STRONG_WINDS)) return
  field.weatherDuration = 0
  field.weather = 0
}

/** VARIOUS_REMOVE_TERRAIN, :7908-7937, then `call BattleScript_OnTerrainChanged` only when a terrain was actually removed (s:685-715). */
function removeTerrain(args: LegacyPostHitArgs): void {
  const field = args.state.field
  if ((field.statuses & STATUS_FIELD_TERRAIN_PERMANENT) === STATUS_FIELD_TERRAIN_PERMANENT) return
  field.timers.terrainTimer = 0
  const hadTerrain = hasFlag(field.statuses, STATUS_FIELD_TERRAIN_ANY)
  field.statuses = clearFlag(field.statuses, STATUS_FIELD_TERRAIN_ANY)
  if (hadTerrain) dispatchOnTerrainChange(args.state, args.deps, args.unmodelled)
}

/**
 * Cmd_setreflect / Cmd_setlightscreen (battle_script_commands.c:9319-9339, 10252-10273) for Baddy Bad / Ice Wall and Glitzy Glow. The
 * script (s:497-560) is a plain hit while the user's side already has that screen, unless the user has Screen Cleaner.
 */
function setScreenAfterHit(args: LegacyPostHitArgs, screen: 'reflect' | 'lightscreen'): void {
  const { state, attackerId, deps } = args
  const attacker = state.battlers[attackerId]
  if (!attacker) return
  const side = state.sides[attackerId & 1]
  const flag = screen === 'reflect' ? SIDE_STATUS_REFLECT : SIDE_STATUS_LIGHTSCREEN
  const cleaner = battlerHasSimAbility(state, attacker, 'ABILITY_SCREEN_CLEANER', false, attackerId, false, deps.dataContext)
  if (hasFlag(side.statuses, flag) && !cleaner) return
  const timer = deps.grounding.holdEffectOf(attackerId) === 'HOLD_EFFECT_LIGHT_CLAY' ? 8 : 5
  side.statuses = setFlag(side.statuses, flag)
  if (screen === 'reflect') {
    side.timers.started.reflect = true
    side.timers.reflectBattlerId = attackerId
    side.timers.reflectTimer = timer
  } else {
    side.timers.started.lightscreen = true
    side.timers.lightscreenBattlerId = attackerId
    side.timers.lightscreenTimer = timer
  }
}

/**
 * What these scripts do AFTER the hit and its seteffectwithchance / tryfaintmon, before moveendall. Not reached when the move missed or was
 * blocked (those jump to BattleScript_PrintMoveMissed). Ghastly Echo's user switch is turn.ts's, next to Volt Switch's.
 */
export function runLegacyPostHit(args: LegacyPostHitArgs): void {
  const { state, attackerId, targetId, moveEffect, targetDamage, deps, unmodelled } = args
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker) return

  switch (moveEffect) {
    case 'EFFECT_RAIN_HIT':
    case 'EFFECT_SANDSTORM_HIT': {
      // s:3426-3435: `setbattleweather ENUM_WEATHER_X, BattleScript_MoveEnd, FALSE` (VARIOUS_SET_WEATHER :8634-8644) + OnWeatherChange.
      const weather = moveEffect === 'EFFECT_RAIN_HIT' ? ENUM_WEATHER_RAIN : ENUM_WEATHER_SANDSTORM
      if (tryChangeBattleWeather(state, attackerId, weather, false, deps)) dispatchOnWeatherChange(state, deps, unmodelled)
      return
    }
    case 'EFFECT_GRASSY_TERRAIN_HIT':
      // s:3444-3453 (setgrassyterrain -> HandleTerrainMove, B_MSG_TERRAINBECOMESGRASSY override, c:6410-6462)
      setFieldTerrain(state, attackerId, STATUS_FIELD_GRASSY_TERRAIN, deps, unmodelled)
      return
    case 'EFFECT_FAIRY_TERRAIN_HIT':
      // s:3454-3464 (setmistyterrain)
      setFieldTerrain(state, attackerId, STATUS_FIELD_MISTY_TERRAIN, deps, unmodelled)
      return
    case 'EFFECT_TAILWIND_HIT':
      // s:3436-3443: settailwind + BattleScript_OnTailwindStart
      startTailwind(state, attackerId, args.moveId, deps, unmodelled)
      return
    case 'EFFECT_CLEAR_WEATHER_AND_TERRAIN_HIT':
      // s:685-715: removeweather (always), then removeterrain
      removeWeather(args)
      removeTerrain(args)
      return
    case 'EFFECT_REMOVE_TERRAIN_NO_FAIL':
      // s:717-745: the argument effect rolled in seteffectwithchance (moveEffects.ts), then removeterrain
      removeTerrain(args)
      return
    case 'EFFECT_SPARKLY_SWIRL': {
      // s:422-449: healpartystatus; gCurrentMove is not Heal Bell so Cmd_healpartystatus takes the Aromatherapy branch (c:11079-11092):
      // the user and every party slot lose their status1, the user also its nightmare.
      attacker.mon.status1 = 0
      attacker.mon.status2 = clearFlag(attacker.mon.status2, STATUS2_NIGHTMARE)
      for (const mon of state.sides[attackerId & 1].party) mon.status1 = 0
      return
    }
    case 'EFFECT_GLITZY_GLOW':
      setScreenAfterHit(args, 'lightscreen')
      return
    case 'EFFECT_BADDY_BAD':
      setScreenAfterHit(args, 'reflect')
      return
    case 'EFFECT_SMELLINGSALT':
      // s:3384-3395 (`jumpifstatus BS_ATTACKER, STATUS1_ANY` -- the ATTACKER, as written): VARIOUS_CURE_STATUS clears status1 only (c:7685-7689).
      if (hasFlag(attacker.mon.status1, STATUS1_ANY)) attacker.mon.status1 = 0
      return
    case 'EFFECT_PLASMA_FISTS':
      // s:397-421: applyplasmafists (VARIOUS_APPLY_PLASMA_FISTS c:8062-8064): STATUS4_PLASMA_FISTS on every battler. The reader is
      // GetMoveTypeInternal (battle_main.c:5197), applied by damageResolver.ts.
      for (const battler of state.battlers) if (battler) battler.statuses4 = setFlag(battler.statuses4, STATUS4_PLASMA_FISTS)
      return
    case 'EFFECT_EERIE_SPELL': {
      // s:4796-4825, VARIOUS_EERIE_SPELL_PP_REDUCE (c:7852-7882): the target's last used move loses `argument` PP (capped at what it has).
      if (!target) return
      const lastMove = target.lastMove
      if (!lastMove || lastMove === 'MOVE_UNSET') return
      const slot = target.mon.moves.indexOf(lastMove)
      if (slot === -1 || target.mon.pp[slot] === 0) return
      const argument = deps.dataContext.move(args.moveId)?.argumentInt ?? 0
      const cut = Math.min(argument, target.mon.pp[slot])
      target.mon.pp[slot] -= cut
      if (target.mon.pp[slot] === 0) cancelMultiTurnMoves(target)
      return
    }
    default:
      void targetDamage
      return
  }
}
