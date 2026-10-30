const CYCLE114 = 'web/src/engine/sim/cycle114StatusEffects.test.ts'
const CYCLE115 = 'web/src/engine/sim/cycle115StatusEffects.test.ts'
const CYCLE115B = 'web/src/engine/sim/cycle115bFieldEffects.test.ts'
const CYCLE116 = 'web/src/engine/sim/cycle116FieldEffects.test.ts'
const CYCLE117 = 'web/src/engine/sim/cycle117FieldEffects.test.ts'
const CYCLE119 = 'web/src/engine/sim/cycle119StatusEffects.test.ts'
const CYCLE120 = 'web/src/engine/sim/cycle120StatusEffects.test.ts'
const CYCLE121 = 'web/src/engine/sim/cycle121StatusEffects.test.ts'
const CYCLE122 = 'web/src/engine/sim/cycle122StatEffects.test.ts'

export const VERIFIED_MOVE_EFFECTS: Map<string, string> = new Map<string, string>(
  [
    'EFFECT_REST',
    'EFFECT_ROOST',
    'EFFECT_RESTORE_HP',
    'EFFECT_HEALING_WISH',
    'EFFECT_SUBSTITUTE',
    'EFFECT_SPEED_UP_2',
    'EFFECT_ATTACK_UP_2',
    'EFFECT_SPECIAL_ATTACK_UP_2',
    'EFFECT_DEFENSE_UP_2',
    'EFFECT_BULK_UP',
    'EFFECT_CALM_MIND',
    'EFFECT_DRAGON_DANCE',
  ]
    .map((effect): [string, string] => [effect, CYCLE114])
    .concat(
      [
        'EFFECT_TOXIC',
        'EFFECT_WILL_O_WISP',
        'EFFECT_PARALYZE',
        'EFFECT_ENCORE',
        'EFFECT_TAUNT',
        'EFFECT_BATON_PASS',
        'EFFECT_PARTING_SHOT',
        'EFFECT_SOFTBOILED',
        'EFFECT_STEALTH_ROCK',
        'EFFECT_LIGHT_SCREEN',
        'EFFECT_REFLECT',
        'EFFECT_SPIKES',
      ].map((effect): [string, string] => [effect, CYCLE115]),
    )
    .concat(
      [
        'EFFECT_TAILWIND',
        'EFFECT_TRICK_ROOM',
        'EFFECT_RAIN_DANCE',
        'EFFECT_SUNNY_DAY',
        'EFFECT_SANDSTORM',
        'EFFECT_HAIL',
        'EFFECT_SAFEGUARD',
        'EFFECT_MIST',
        'EFFECT_LEECH_SEED',
        'EFFECT_TOXIC_SPIKES',
        'EFFECT_ELECTRIC_TERRAIN',
        'EFFECT_GRASSY_TERRAIN',
      ].map((effect): [string, string] => [effect, CYCLE115B]),
    )
    .concat(
      [
        'EFFECT_PSYCHIC_TERRAIN',
        'EFFECT_MISTY_TERRAIN',
        'EFFECT_WORRY_SEED',
        'EFFECT_WONDER_ROOM',
        'EFFECT_MAGIC_ROOM',
        'EFFECT_LUCKY_CHANT',
        'EFFECT_MAGNET_RISE',
        'EFFECT_INGRAIN',
        'EFFECT_GRAVITY',
        'EFFECT_AURORA_VEIL',
        'EFFECT_SMOKESCREEN',
        'EFFECT_ENTRAINMENT',
      ].map((effect): [string, string] => [effect, CYCLE116]),
    )
    .concat(
      [
        'EFFECT_STICKY_WEB',
        'EFFECT_MAGNETIC_FLUX',
        'EFFECT_AROMATIC_MIST',
        'EFFECT_REFLECT_TYPE',
        'EFFECT_DRAIN_BRAIN',
        'EFFECT_MORNING_SUN',
        'EFFECT_INVERSE_ROOM',
        'EFFECT_TOXIC_TERRAIN',
        'EFFECT_CLEAR_SKIES',
      ].map((effect): [string, string] => [effect, CYCLE117]),
    )
    .concat(
      [
        'EFFECT_SLEEP',
        'EFFECT_YAWN',
        'EFFECT_SWAGGER',
        'EFFECT_CONFUSE',
        'EFFECT_ATTRACT',
        'EFFECT_CURSE',
        'EFFECT_TORMENT',
        'EFFECT_AQUA_RING',
        'EFFECT_HEAL_BLOCK',
        'EFFECT_SOAK',
        'EFFECT_DISABLE',
        'EFFECT_SLEEP_TALK',
      ].map((effect): [string, string] => [effect, CYCLE119]),
    )
    .concat(
      [
        'EFFECT_SPITE',
        'EFFECT_MEAN_LOOK',
        'EFFECT_FORESIGHT',
        'EFFECT_PARALYZE_IGNORE_TYPE',
        'EFFECT_MIRACLE_EYE',
        'EFFECT_SKILL_SWAP',
        'EFFECT_GASTRO_ACID',
        'EFFECT_FLATTER',
        'EFFECT_IMPRISON',
        'EFFECT_DESTINY_BOND',
        'EFFECT_PERISH_SONG',
        'EFFECT_POISON',
      ].map((effect): [string, string] => [effect, CYCLE120]),
    )
    .concat(
      [
        'EFFECT_TELEKINESIS',
        'EFFECT_MAT_BLOCK',
        'EFFECT_LOCK_ON',
        'EFFECT_SIMPLE_BEAM',
        'EFFECT_TOXIC_THREAD',
        'EFFECT_EMBARGO',
        'EFFECT_ROLE_PLAY',
      ].map((effect): [string, string] => [effect, CYCLE121]),
    )
    .concat(
      [
        'EFFECT_ATTACK_DOWN_2',
        'EFFECT_ATTACK_SPATK_UP',
        'EFFECT_ATTACK_DOWN',
        'EFFECT_HAZE',
        'EFFECT_SPECIAL_DEFENSE_DOWN_2',
        'EFFECT_DEFENSE_UP',
        'EFFECT_DEFENSE_CURL',
        'EFFECT_DEFENSE_DOWN',
        'EFFECT_SPECIAL_ATTACK_DOWN',
        'EFFECT_GROWTH',
        'EFFECT_ATTACK_ACCURACY_UP',
        'EFFECT_SPEED_DOWN_2',
      ].map((effect): [string, string] => [effect, CYCLE122]),
    ),
)

interface GateView {
  power?: number | null
  effect?: string | null
}

export function isGatedMove(move: GateView): boolean {
  return !move.power || move.power <= 1
}

export function isEligibleMove(move: GateView): boolean {
  return !isGatedMove(move) || VERIFIED_MOVE_EFFECTS.has(move.effect ?? 'NONE')
}
