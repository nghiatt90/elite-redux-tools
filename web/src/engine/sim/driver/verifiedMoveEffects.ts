const CYCLE114 = 'web/src/engine/sim/cycle114StatusEffects.test.ts'
const CYCLE115 = 'web/src/engine/sim/cycle115StatusEffects.test.ts'
const CYCLE115B = 'web/src/engine/sim/cycle115bFieldEffects.test.ts'
const CYCLE116 = 'web/src/engine/sim/cycle116FieldEffects.test.ts'
const CYCLE117 = 'web/src/engine/sim/cycle117FieldEffects.test.ts'

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
