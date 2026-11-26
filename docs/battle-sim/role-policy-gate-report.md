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
- `baton boost step fired`: turns where the role policy's own trace slice holds a `support`/`setup` decision -- the Baton Pass own-boost step chose the move, even if the move was then cancelled. It is read from the role policy's trace, so the expectimax row is always `-`.
- `boost passes`: turns where the chosen move's effect is `EFFECT_BATON_PASS`, the active mon is boosted at decision time and has itself boosted since its current switch-in. Team-layer and role-layer pivots both count.
- `boost received`: of those passes, the ones that executed and where, at our next decision, a different party slot is active, alive, and still above neutral in at least one stat the passer was above neutral in. A receiver that faints before the next decision, or a battle that ends first, is not counted.
- AI voluntary switches: turns where the AI's selection-time action is `SWITCH`, broken down by what our policy did that turn (a move id, `SWITCH`, or `NONE`). Replacements after a faint and pivot moves are not counted.
- `team` voluntary switch: a turn whose own trace slice holds a `team`-tagged decision with that purpose, and whose chosen action is a switch -- a `SWITCH` action or a pivot move carrying `switchTo`. The chosen switch counts even if a pivot then misses or is cancelled. Faint replacements and role-layer pivots carry no `team` tag and are not counted.
- `team` turns without switch: a `team`-tagged decision whose chosen action is not a switch (for example `sacrifice` leaving the active mon in as fodder). Kept apart so the switch columns stay honest.
- `stay-test turns`: turns where a read-only probe of the same stay test the team layer runs (`stayTest(session, readPredictions(session, DEFAULT_SAFETY_PCT))`, before the policy runs, role policy only) returned `stay`. `stay with outspeeding KO` also returned `outspeedsWithKo`, so every purpose is skipped. `preserve fired on a stay turn` is a stay turn without an outspeeding KO whose trace shows `team`/`preserve`.
- Stay-test limit: these count turns where the stay test closed the purposes. They do not say a purpose would have switched on that turn, so they are an upper bound on "switches blocked by the stay test"; the exact counterfactual cannot be measured without changing `teamLayer.ts`, which is out of scope.
- `ms/game` is wall time per game. It was measured with six fights running in parallel on 8 cores, so it is contested. For role games the stay-probe wall time is subtracted; the probe adds time to role games only.
- Turn 1 action: the role policy's choice on the first turn -- `SWITCH` for a hard switch, `NONE` for a null choice, otherwise the chosen move id (a pivot move is reported by its move id).
- Classification: `uninformative` when both win rates are strictly under 20%; otherwise `role>=expectimax` or `role<expectimax` from the raw win rates.

## Results

| Fight | Policy | Wins | Games | Rate | Wilson low | Wilson high | ms/game | Capped | Available | Used | Boosted | Attacked boosted | Any positive stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 985.0 | 0 | 87 | 0 | 0 | 0 | 0 |
| TRAINER_SIDNEY-attack | expectimax | 71 | 80 | 88.8% | 0.800 | 0.940 | 2145.2 | 0 | 298 | 100 | 102 | 28 | 218 |
| TRAINER_PHOEBE-attack | role | 58 | 80 | 72.5% | 0.619 | 0.811 | 1104.2 | 0 | 21 | 0 | 0 | 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | 15 | 80 | 18.8% | 0.117 | 0.287 | 1734.7 | 0 | 276 | 4 | 10 | 10 | 10 |
| TRAINER_GLACIA-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 1303.0 | 0 | 173 | 0 | 0 | 0 | 2 |
| TRAINER_GLACIA-attack | expectimax | 0 | 80 | 0.0% | 0.000 | 0.046 | 1705.9 | 0 | 307 | 38 | 79 | 53 | 123 |
| TRAINER_DRAKE-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 604.2 | 0 | 80 | 0 | 0 | 0 | 0 |
| TRAINER_DRAKE-attack | expectimax | 30 | 80 | 37.5% | 0.277 | 0.485 | 2255.4 | 0 | 404 | 19 | 23 | 20 | 75 |
| TRAINER_STEVEN-attack | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 816.1 | 0 | 87 | 0 | 0 | 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | 0 | 80 | 0.0% | 0.000 | 0.046 | 1417.6 | 0 | 202 | 0 | 0 | 0 | 80 |
| TRAINER_GLACIA-stall | role | 0 | 80 | 0.0% | 0.000 | 0.046 | 2605.7 | 11 | 266 | 0 | 0 | 0 | 187 |
| TRAINER_GLACIA-stall | expectimax | 5 | 80 | 6.3% | 0.027 | 0.138 | 5876.5 | 0 | 452 | 0 | 0 | 0 | 185 |

## AI voluntary switches

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 25 | MOVE_SNIPE_SHOT=19, SWITCH=4, MOVE_BATON_PASS=2 |
| TRAINER_GLACIA-attack | expectimax | 3 | MOVE_MOONBLAST=2, MOVE_SNIPE_SHOT=1 |
| TRAINER_DRAKE-attack | role | 0 | none |
| TRAINER_DRAKE-attack | expectimax | 75 | MOVE_MOONBLAST=57, SWITCH=18 |
| TRAINER_STEVEN-attack | role | 4 | MOVE_BATON_PASS=2, MOVE_MOONBLAST=2 |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 3 | MOVE_SEISMIC_TOSS=3 |
| TRAINER_GLACIA-stall | expectimax | 5 | MOVE_ASTEROID_DOWNFALL=4, MOVE_FIRE_BLAST=1 |

## Baton Pass own boosts

| Fight | Policy | Own-boost step fired | Boost passes | Boost received |
| --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | 0 | 0 |
| TRAINER_SIDNEY-attack | expectimax | - | 8 | 4 |
| TRAINER_PHOEBE-attack | role | 0 | 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | - | 0 | 0 |
| TRAINER_GLACIA-attack | role | 0 | 0 | 0 |
| TRAINER_GLACIA-attack | expectimax | - | 3 | 3 |
| TRAINER_DRAKE-attack | role | 0 | 0 | 0 |
| TRAINER_DRAKE-attack | expectimax | - | 0 | 0 |
| TRAINER_STEVEN-attack | role | 0 | 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | - | 0 | 0 |
| TRAINER_GLACIA-stall | role | 0 | 0 | 0 |
| TRAINER_GLACIA-stall | expectimax | - | 0 | 0 |

## Team layer (role policy)

| Fight | preserve | sacrifice | counter | entryAbility | support | ppLoop | Team turns without switch | Stay-test turns | Stay with outspeeding KO | Preserve fired on a stay turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | 0 | 133 | 0 | 0 | 0 | 0 | sacrifice=421 | 275 | 192 | 0 |
| TRAINER_PHOEBE-attack | 0 | 96 | 0 | 0 | 0 | 0 | sacrifice=315 | 442 | 442 | 0 |
| TRAINER_GLACIA-attack | 0 | 278 | 78 | 0 | 16 | 0 | sacrifice=552 | 170 | 144 | 0 |
| TRAINER_DRAKE-attack | 0 | 162 | 0 | 0 | 0 | 0 | sacrifice=238 | 85 | 1 | 0 |
| TRAINER_STEVEN-attack | 0 | 145 | 1 | 0 | 6 | 0 | sacrifice=313 | 259 | 151 | 0 |
| TRAINER_GLACIA-stall | 0 | 451 | 5 | 0 | 0 | 0 | sacrifice=1809 | 331 | 141 | 0 |

## Turn 1 actions (role policy)

| Fight | Turn 1 action counts |
| --- | --- |
| TRAINER_SIDNEY-attack | MOVE_FURY_CUTTER=80 |
| TRAINER_PHOEBE-attack | MOVE_RAIN_DANCE=80 |
| TRAINER_GLACIA-attack | SWITCH=80 |
| TRAINER_DRAKE-attack | MOVE_BOOMBURST=80 |
| TRAINER_STEVEN-attack | MOVE_WAVE_CRASH=80 |
| TRAINER_GLACIA-stall | MOVE_SAFE_PASSAGE=80 |

## Classification

| Fight | Role rate | Expectimax rate | Classification |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | 0.0% | 88.8% | role<expectimax |
| TRAINER_PHOEBE-attack | 72.5% | 18.8% | role>=expectimax |
| TRAINER_GLACIA-attack | 0.0% | 0.0% | uninformative |
| TRAINER_DRAKE-attack | 0.0% | 37.5% | role<expectimax |
| TRAINER_STEVEN-attack | 0.0% | 0.0% | uninformative |
| TRAINER_GLACIA-stall | 0.0% | 6.3% | uninformative |

## Informative fights where the role policy wins less often

Informative fights (classification other than `uninformative`): 3.

- TRAINER_SIDNEY-attack: role 0/80, Wilson [0.000, 0.046]; expectimax 71/80, Wilson [0.800, 0.940]; intervals do not overlap.
- TRAINER_DRAKE-attack: role 0/80, Wilson [0.000, 0.046]; expectimax 30/80, Wilson [0.277, 0.485]; intervals do not overlap.

This checks only the "at least as often as expectimax on every informative fight" part of Step 2.0b. "Clearly more" on the stall fight and where Mr. Mime's boosts decide, and the reading of the battle logs, are not evaluated here; no overall verdict is given.

## Battle logs

- TRAINER_SIDNEY-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_SIDNEY-attack.log`
- TRAINER_PHOEBE-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_PHOEBE-attack.log`
- TRAINER_GLACIA-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_GLACIA-attack.log`
- TRAINER_DRAKE-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_DRAKE-attack.log`
- TRAINER_STEVEN-attack: `docs/battle-sim/role-policy-logs/role-TRAINER_STEVEN-attack.log`
- TRAINER_GLACIA-stall: `docs/battle-sim/role-policy-logs/role-TRAINER_GLACIA-stall.log`
