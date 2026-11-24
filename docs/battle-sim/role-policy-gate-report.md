SMOKE RUN: 4 games per policy; this is not the gate measurement.

# Role policy gate report

Written by `web/src/engine/sim/driver/policyComparison.test.ts` from the measured results. Nothing here is typed by hand.

- Games per policy: 4
- Turn cap: 200
- Seeds: `seedOffset + g * 1000` for game g, seedOffset 0 (game 1 = 1000); both policies use the same seed per game.
- Wilson z: 1.96
- Fixture: `docs/battle-sim/role-policy-test-fights.json`

## Definitions

- A game counts as won only on `WON`; a capped game (`MAX_TURNS`) counts as not won.
- Boosting move: a move `boostStatsOf` recognises as a self-boost, or a STATUS move targeting the user whose effect matches `^EFFECT_(DEFENSE|SPECIAL_DEFENSE)_UP(_2|_3)?$` (Iron Defense is `EFFECT_DEFENSE_UP_2`).
- `available`: turns where our active mon is alive and a legal USE_MOVE choice is a boosting move.
- `used`: turns where the chosen move is a boosting move.
- `boosted`: turns where our active mon at decision time has any of stat stages 1..5 above neutral.
- `attacked while boosted`: boosted turns where the chosen move's split is not STATUS.
- AI voluntary switches: turns where the AI's selection-time action is `SWITCH`, broken down by what our policy did that turn (a move id, `SWITCH`, or `NONE`). Replacements after a faint and pivot moves are not counted.
- Classification: `uninformative` when both win rates are strictly under 20%; otherwise `role>=expectimax` or `role<expectimax` from the raw win rates.

## Results

| Fight | Policy | Wins | Games | Rate | Wilson low | Wilson high | ms/game | Capped | Available | Used | Boosted | Attacked boosted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | 4 | 0.0% | 0.000 | 0.490 | 924.2 | 0 | 7 | 0 | 2 | 2 |
| TRAINER_SIDNEY-attack | expectimax | 4 | 4 | 100.0% | 0.510 | 1.000 | 1843.2 | 0 | 18 | 8 | 10 | 4 |
| TRAINER_PHOEBE-attack | role | 3 | 4 | 75.0% | 0.301 | 0.954 | 986.3 | 0 | 2 | 0 | 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | 1 | 4 | 25.0% | 0.046 | 0.699 | 1405.9 | 0 | 16 | 1 | 3 | 3 |
| TRAINER_GLACIA-attack | role | 0 | 4 | 0.0% | 0.000 | 0.490 | 901.0 | 0 | 4 | 0 | 1 | 1 |
| TRAINER_GLACIA-attack | expectimax | 0 | 4 | 0.0% | 0.000 | 0.490 | 1301.5 | 0 | 13 | 3 | 8 | 6 |
| TRAINER_DRAKE-attack | role | 0 | 4 | 0.0% | 0.000 | 0.490 | 809.8 | 0 | 5 | 0 | 0 | 0 |
| TRAINER_DRAKE-attack | expectimax | 3 | 4 | 75.0% | 0.301 | 0.954 | 1773.2 | 0 | 20 | 1 | 1 | 1 |
| TRAINER_STEVEN-attack | role | 0 | 4 | 0.0% | 0.000 | 0.490 | 687.8 | 0 | 4 | 0 | 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | 0 | 4 | 0.0% | 0.000 | 0.490 | 1021.0 | 0 | 6 | 0 | 4 | 4 |
| TRAINER_GLACIA-stall | role | 0 | 4 | 0.0% | 0.000 | 0.490 | 3244.1 | 0 | 16 | 0 | 12 | 12 |
| TRAINER_GLACIA-stall | expectimax | 1 | 4 | 25.0% | 0.046 | 0.699 | 6430.6 | 0 | 31 | 0 | 11 | 7 |

## AI voluntary switches

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 0 | none |
| TRAINER_GLACIA-attack | expectimax | 0 | none |
| TRAINER_DRAKE-attack | role | 0 | none |
| TRAINER_DRAKE-attack | expectimax | 3 | MOVE_MOONBLAST=3 |
| TRAINER_STEVEN-attack | role | 0 | none |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 0 | none |
| TRAINER_GLACIA-stall | expectimax | 4 | MOVE_ASTEROID_DOWNFALL=4 |

## Classification

| Fight | Role rate | Expectimax rate | Classification |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | 0.0% | 100.0% | role<expectimax |
| TRAINER_PHOEBE-attack | 75.0% | 25.0% | role>=expectimax |
| TRAINER_GLACIA-attack | 0.0% | 0.0% | uninformative |
| TRAINER_DRAKE-attack | 0.0% | 75.0% | role<expectimax |
| TRAINER_STEVEN-attack | 0.0% | 0.0% | uninformative |
| TRAINER_GLACIA-stall | 0.0% | 25.0% | role<expectimax |

## Battle logs

- TRAINER_SIDNEY-attack: `web/test-results/role-policy/role-TRAINER_SIDNEY-attack.log`
- TRAINER_PHOEBE-attack: `web/test-results/role-policy/role-TRAINER_PHOEBE-attack.log`
- TRAINER_GLACIA-attack: `web/test-results/role-policy/role-TRAINER_GLACIA-attack.log`
- TRAINER_DRAKE-attack: `web/test-results/role-policy/role-TRAINER_DRAKE-attack.log`
- TRAINER_STEVEN-attack: `web/test-results/role-policy/role-TRAINER_STEVEN-attack.log`
- TRAINER_GLACIA-stall: `web/test-results/role-policy/role-TRAINER_GLACIA-stall.log`
