# Set solver

Private tool. Given a team of six species and one boss trainer, it searches each member's ability,
item, nature, EV template and moves for the set that wins most often in the simulator.

## Run

```bash
npm --prefix web run solver:build
node web/dist-solver/solverCli.mjs --trainer TRAINER_X --team SPECIES_A,SPECIES_B,SPECIES_C,SPECIES_D,SPECIES_E,SPECIES_F --level 50 --passes 2 --out .omc/solver/x.json
```

Run it from the repository root (it reads `data/v2.65beta` relative to the working directory, or
`ER_DATA_DIR`). Flags: `--tier` (default `elite`), `--workers` (default CPU count minus one),
`--passes`, `--out`.

## How it plays and scores

- The player side is played by a depth-1 expectimax (`driver/expectimax.ts`): every move and every
  voluntary switch is simulated against six sampled opponent actions from the ported trainer AI,
  and the resulting positions are scored on HP, mons alive and stat stages plus, since cycle 147
  (`statusTerms`, default on), status, volatile, side-condition and field terms
  (`solver-evaluation.md`). On a 24-battle check
  it won 19 against 2 for the old "highest base power" policy. Depth 2 won 21 at about 4x the cost.
- Fitness is the win rate over seeded battles (same seeds for every candidate) plus a small
  tie-breaker from the end-of-battle position.
- Search is coordinate ascent: screen a member's neighbours on a few battles, confirm the best
  three on more, keep a change only if it beats the incumbent.

## Move pool

`candidateMoves` (`driver/solver.ts`) offers, per species and level, its strongest damaging moves
(power above 1, ranked by power times STAB times accuracy, dominated split twins dropped) plus the
`UTILITY_MOVES` whitelist. That is the **default pool**, and it is the only one the solver uses
today: `SearchOptions.widePool` and the `{ wide }` argument both default to `false`.

The **wide pool** (`wide: true`) also offers every learnable non-damaging move (power 0 or 1) that
passes the gate, ranked after the damaging ones. The whitelist is subject to the same gate in wide
mode.

The gate lives in `driver/verifiedMoveEffects.ts`. A move is *gated* when `!power || power <= 1`;
damaging moves are never gated. A gated move is *eligible* only if its effect key (`effect ?? 'NONE'`)
is in `VERIFIED_MOVE_EFFECTS`, which maps the key to the test file that proves the effect against the
C. Nothing is grandfathered. Effects the C does not make worth modelling are listed in
`driver/auditAllowlist.ts` with a reason and a C citation (doubles-only effects and no-ops); they are
not eligible, only exempt from the audit. `cycle112WidePool.test.ts` fails if a learnable gated effect
key is neither verified nor allowlisted. It is limited to learnable moves: `MOVE_NONE` and
`MOVE_TEMPEST_STORM` (the only gated moves with no effect key) are not learned by any species, and
Tempest Storm, which two trainer parties carry, is covered by `cycle138bMoveTypes.test.ts`.

`widePool` stays off. The position score now values status, volatile, hazard, screen, tailwind,
weather, terrain and Trick Room effects (`statusTerms`; see `solver-evaluation.md` for the terms,
the scenarios that check them and the bench result), so the earlier reason, that such a move would
be modelled in battle but not valued by the search, no longer holds. Turning the wide pool on is
left to the solver design session (D4).

## Limits

- Win rate is against the sim's mechanics, which still have gaps (see `unmodelled` notes from the
  smoke run) and singles only; the 5 mandatory doubles fights are out of scope.
- A confirmed set was chosen on the same seeds it was scored on, so re-check a result on fresh seeds
  before trusting a win rate of exactly 1.0.
- The item and utility-move pools are curated lists in `driver/solver.ts`.
