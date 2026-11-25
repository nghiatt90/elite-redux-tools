# Role policy gate report

Written by `web/src/engine/sim/driver/policyComparison.test.ts` from the measured results. Nothing here is typed by hand.

- Games per policy: 80
- Turn cap: 200
- Seeds: `seedOffset + g * 1000` for game g, seedOffset 0 (game 1 = 1000); both policies use the same seed per game.
- Wilson z: 1.96
- Fixture: `docs/battle-sim/role-policy-test-fights.json`

## Definitions

- A game counts as won only on `WON`; a capped game (`MAX_TURNS`) counts as not won.
- Boosting move: a move `boostStatsOf` recognises as a self-boost, or a STATUS move targeting the user whose effect matches `^EFFECT_(DEFENSE|SPECIAL_DEFENSE)_UP(_2|_3)?$` (Iron Defense is `EFFECT_DEFENSE_UP_2`).
- `available`: turns where our active mon is alive and a legal USE_MOVE choice is a boosting move.
- `used`: turns where the chosen move is a boosting move.
- `boosted`: turns where our active mon at decision time has any of stat stages 1..5 above neutral and has itself used a boosting move since its current switch-in.
- `attacked while boosted`: boosted turns where the chosen move's split is not STATUS.
- `any positive stage`: turns where our active mon at decision time has any of stat stages 1..5 above neutral, whatever raised them (passive raises and Baton-Passed stages included).
- AI voluntary switches: turns where the AI's selection-time action is `SWITCH`, broken down by what our policy did that turn (a move id, `SWITCH`, or `NONE`). Replacements after a faint and pivot moves are not counted.
- Classification: `uninformative` when both win rates are strictly under 20%; otherwise `role>=expectimax` or `role<expectimax` from the raw win rates.

## Results

| Fight | Policy | Wins | Games | Rate | Wilson low | Wilson high | ms/game | Capped | Available | Used | Boosted | Attacked boosted | Any positive stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 1 | 80 | 1.3% | 0.002 | 0.067 | 1091.4 | 0 | 155 | 0 | 0 | 0 | 9 |
| TRAINER_SIDNEY-attack | expectimax | 71 | 80 | 88.8% | 0.800 | 0.940 | 2041.7 | 0 | 298 | 100 | 102 | 28 | 218 |
| TRAINER_PHOEBE-attack | role | 60 | 80 | 75.0% | 0.645 | 0.832 | 1186.9 | 0 | 40 | 0 | 0 | 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | 15 | 80 | 18.8% | 0.117 | 0.287 | 1588.9 | 0 | 276 | 4 | 10 | 10 | 10 |
| TRAINER_GLACIA-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 1177.0 | 0 | 105 | 0 | 0 | 0 | 1 |
| TRAINER_GLACIA-attack | expectimax | 0 | 80 | 0.0% | 0.000 | 0.046 | 1626.2 | 0 | 307 | 38 | 79 | 53 | 123 |
| TRAINER_DRAKE-attack | role | 1 | 80 | 1.3% | 0.002 | 0.067 | 968.8 | 0 | 132 | 32 | 32 | 0 | 73 |
| TRAINER_DRAKE-attack | expectimax | 30 | 80 | 37.5% | 0.277 | 0.485 | 2118.4 | 0 | 404 | 19 | 23 | 20 | 75 |
| TRAINER_STEVEN-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 784.6 | 0 | 72 | 0 | 0 | 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | 0 | 80 | 0.0% | 0.000 | 0.046 | 1389.2 | 0 | 202 | 0 | 0 | 0 | 80 |
| TRAINER_GLACIA-stall | role | 3 | 80 | 3.8% | 0.013 | 0.105 | 2648.7 | 0 | 304 | 0 | 0 | 0 | 224 |
| TRAINER_GLACIA-stall | expectimax | 5 | 80 | 6.3% | 0.027 | 0.138 | 5739.2 | 0 | 452 | 0 | 0 | 0 | 185 |

## AI voluntary switches

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 1 | MOVE_MOONBLAST=1 |
| TRAINER_GLACIA-attack | expectimax | 3 | MOVE_MOONBLAST=2, MOVE_SNIPE_SHOT=1 |
| TRAINER_DRAKE-attack | role | 2 | MOVE_SHOCKING_JAB=2 |
| TRAINER_DRAKE-attack | expectimax | 75 | MOVE_MOONBLAST=57, SWITCH=18 |
| TRAINER_STEVEN-attack | role | 0 | none |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 0 | none |
| TRAINER_GLACIA-stall | expectimax | 5 | MOVE_ASTEROID_DOWNFALL=4, MOVE_FIRE_BLAST=1 |

## Classification

| Fight | Role rate | Expectimax rate | Classification |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | 1.3% | 88.8% | role<expectimax |
| TRAINER_PHOEBE-attack | 75.0% | 18.8% | role>=expectimax |
| TRAINER_GLACIA-attack | 0.0% | 0.0% | uninformative |
| TRAINER_DRAKE-attack | 1.3% | 37.5% | role<expectimax |
| TRAINER_STEVEN-attack | 0.0% | 0.0% | uninformative |
| TRAINER_GLACIA-stall | 3.8% | 6.3% | uninformative |

## Informative fights where the role policy wins less often

Informative fights (classification other than `uninformative`): 3.

- TRAINER_SIDNEY-attack: role 1/80, Wilson [0.002, 0.067]; expectimax 71/80, Wilson [0.800, 0.940]; intervals do not overlap.
- TRAINER_DRAKE-attack: role 1/80, Wilson [0.002, 0.067]; expectimax 30/80, Wilson [0.277, 0.485]; intervals do not overlap.

This checks only the "at least as often as expectimax on every informative fight" part of Step 2.0b. "Clearly more" on the stall fight and where Mr. Mime's boosts decide, and the reading of the battle logs, are not evaluated here; no overall verdict is given.

## Battle logs

- TRAINER_SIDNEY-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_SIDNEY-attack.log`
- TRAINER_PHOEBE-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_PHOEBE-attack.log`
- TRAINER_GLACIA-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_GLACIA-attack.log`
- TRAINER_DRAKE-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_DRAKE-attack.log`
- TRAINER_STEVEN-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_STEVEN-attack.log`
- TRAINER_GLACIA-stall: `docs/battle-sim/role-policy-logs/role-TRAINER_GLACIA-stall.log`
