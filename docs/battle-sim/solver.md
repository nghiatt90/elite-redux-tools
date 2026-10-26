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
  and the resulting positions are scored on HP, mons alive and stat stages. On a 24-battle check
  it won 19 against 2 for the old "highest base power" policy. Depth 2 won 21 at about 4x the cost.
- Fitness is the win rate over seeded battles (same seeds for every candidate) plus a small
  tie-breaker from the end-of-battle position.
- Search is coordinate ascent: screen a member's neighbours on a few battles, confirm the best
  three on more, keep a change only if it beats the incumbent.

## Limits

- Win rate is against the sim's mechanics, which still have gaps (see `unmodelled` notes from the
  smoke run) and singles only; the 5 mandatory doubles fights are out of scope.
- A confirmed set was chosen on the same seeds it was scored on, so re-check a result on fresh seeds
  before trusting a win rate of exactly 1.0.
- The item and utility-move pools are curated lists in `driver/solver.ts`.
