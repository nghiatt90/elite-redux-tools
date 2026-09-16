// The simulator's random source.
//
// This is deliberately NOT a port of the game's generator. docs/battle-sim/plan.md's
// scope decision 3 gives up bit-exactness: the sim models mechanics correctly and
// runs many battles for a win probability, rather than reproducing `gRngValue`'s
// sequence call for call. Since the sequence is not being matched, the algorithm
// behind it does not have to be the game's -- only the *shape* of each draw does.
//
// What the shape has to be, so transcribed AI branches keep their distributions:
//
//   - `Random()` (include/random.h:8) returns a u16, 0..65535. Call sites use it
//     raw and modulo it themselves -- `Random() % 100 < 50`
//     (battle_ai_main.c:1638), `Random() % 0xFF` (battle_ai_util.c:441).
//   - `AI_RandLessThan(val)` is `(Random() % 0xFF) < val`. Note 0xFF is 255, not
//     256: the modulus is one short of a byte, so the distribution is over 0..254
//     and `AI_RandLessThan(255)` is always true while `AI_RandLessThan(0)` is
//     always false. That off-by-one is the game's, and a port must keep it; it
//     lives with the AI transcription, not here, which is why this module
//     exposes the raw u16 rather than a ready-made `randLessThan`.
//
// Anything that needs a different width builds it from `random16()` the way the
// game does (`Random32()` is `Random() | (Random() << 16)`, random.h:12).

import type { RandomSource } from './state'

/** A seeded RandomSource. `seed` is any 32-bit value; the same seed always
 * produces the same stream, which is what makes a reported win probability
 * reproducible and a surprising battle re-playable. */
export function createRandomSource(seed: number): RandomSource {
  // mulberry32 -- a small, fast, well-distributed 32-bit PRNG. Chosen because it
  // is one self-contained integer step with no dependency and no global state,
  // so a sim run is a pure function of its seed. Its statistical quality is
  // irrelevant to fidelity here (the game's own LCG is far worse); what matters
  // is that repeated draws are independent enough that averaging thousands of
  // battles converges.
  let state = seed >>> 0
  return {
    random16(): number {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      t = (t ^ (t >>> 14)) >>> 0
      // Take the HIGH 16 bits: the low bits of an xorshift-multiply output are
      // the weakest, and every consumer here immediately takes a modulo, which
      // is exactly the operation that would expose them.
      return t >>> 16
    },
  }
}
