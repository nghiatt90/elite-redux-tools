# Role policy diagnosis: why the boost rule never fired

Cycle 20f1. Question from the gate report (`role-policy-gate-report.md`, 80 games per policy,
`ec651c9`): the role policy used a boosting move **0 times in every fight** though one was legal on
155 turns against Sidney and 100 against Drake. Supervisor's reading to verify: "Mr. Mime always
Baton Passes with no boosts while threatened, and no set-up sweeper ever boosts."

Method: a throwaway probe replayed the fixture (`role-policy-test-fights.json`) through
`buildFightSetup` + `createTeamLayer` + `playPolicyBattle`, exactly as `playComparisonGame`
(`policyComparison.ts:485-494`) does, and logged per turn the active mon, the chosen action, the
layer/role tag that decided it, and every set-up gate (`readPredictions(...).threatened` /
`koThreat`, the undo scan, the current stage, the bench slot). All numbers below come from that
replay; the probe was deleted afterwards. `policyComparison.test.ts` was never run with
`SIM_POLICY` set, so the committed report and logs are untouched.

## Headline

- **The committed logs are still the current code.** On all four logged seeds (Sidney 1000/2000,
  Drake 1000/2000) the replay matches the logs turn by turn — same choice, same tag, same switch
  target, same outcome and turn count (Sidney 9/12, Drake 10/10). Nothing in the replay differs
  from the committed logs, so the later `rolePolicy.ts` / `teamLayer.ts` fixes did not change these
  games.
- **No sweeper is on the field in Sidney or Drake.** The fixture gives a `sweeper` role only to
  Rhyperior in the Glacia stall fight. The boost the report counted in Sidney/Drake is Mr. Mime's
  Calm Mind (and its Iron Defense, which the report's `isBoostingMove` counts but `boostStatsOf`
  does not). Mr. Mime is a `support`.
- **The undo bug is real but was not the log-seed blocker.** It fires only in Drake games where
  Dialga is alive when Mr. Mime is out: 3 of 10 replay games before the fix (games 3, 5 and 7,
  at turn 4). Those games now set up (6 Calm Minds in 10 games).
- **After the fix the role policy still never boosts against Sidney, and still never boosts
  Rhyperior in the Glacia stall fight.** In both cases the freeze is `view.threatened`, a gate the
  plan does not give the support role and a safety line that is closed at 25/50/75% for Rhyperior.
  Both are design questions below, not bugs I could fix without a decision.

## Aggregate gate counts (10 role games per fight, seeds 1000..10000)

A "boost turn" = a turn where the active mon has a legal `boostStatsOf` move (Calm Mind or Swords
Dance in these teams). Replay after the fix:

| Fight | Boost turns | Used | Chosen instead | threatened 25 / 50 / 75% |
| --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack (Mr. Mime) | 16 | 0 | Baton Pass 10 (`support:pivot`), Moonblast 6 (`support:ko` 5, `support:damage` 1) | 16 / 16 / 10 |
| TRAINER_DRAKE-attack (Mr. Mime) | 19 | 6 | Baton Pass 13 (10 threatened, 3 already at +2) | 10 / 10 / 10 |
| TRAINER_GLACIA-stall (Rhyperior) | 38 | 0 | Asteroid Downfall 38 (`setupSweeper:ko` 29, `:damage` 9) | 38 / 38 / 38 |

**No team purpose fired on any of these 73 boost turns** — every decision came from the role rule
(`tags[0] === 'support'` or `'setupSweeper'`). The team layer did fire on turn 1 of every attack
fight (`team:support`), and the plan mandates that order (decision 14: "Team layer, checked before
the active mon's role rule"), so that is intended.

## Sidney attack

Fixture: lead Scyther (attacker), roles attacker x4, support x2 (Kingdra, Mr. Mime); no sweeper.
Mr. Mime's set is Moonblast / Iron Defense / Calm Mind / Baton Pass.

- Turn 1: `team:support` switches Scyther out to Kingdra (Kingdra's Rain Dance is a pending effect
  and Kingdra is an acceptable switch-in). Not a boost turn: the active Scyther has no boost move.
- Turn 2: `support:weather` Rain Dance (Kingdra); not a boost turn.
- The only boost turns are Mr. Mime's. Committed log game 1 turn 7, game 2 turns 6 and 10, all
  `trace: support:pivot MOVE_BATON_PASS`. Replay gate inputs on those turns:
  `threatened=true` (Wicked Blow / Oblivion Wing / Heat Wave), `koThreat=false`/`false`/`true`,
  undo scan empty (Sidney's party has no Haze, phazing move or Unaware slot), stage 0, bench 2/1/2.
- Why Baton Pass: `chooseSupport` (`rolePolicy.ts:1452`) runs (1) `chooseSupportSetter` — nothing
  to set with this set — (2) `chooseBatonPassSetup` (`:1395`), which returns null at its
  `view.threatened` gate (`:1411`), then (3) the pivot hand-off. With no bench the same gate falls
  through to the attacker fallback, which is Moonblast (`support:ko`).
- So the turn-7/6/10 Baton Passes are the support role's own gate, not the undo bug: the undo scan
  was empty on every one of them.

After the fix, Sidney is unchanged: 0 boosts in 10 games. The blocker is the `threatened` line
(16/16 at 50%). At a 75% line 6 of the 16 would be safe, so the parameter matters here; decision
14 gives `support` no safety parameter (only the fallback-role gene), so lowering the line or
dropping the gate is a design choice (question 1).

## Drake attack

Fixture roles are the same as Sidney (no sweeper; Mr. Mime is the boost carrier). Drake's elite
party contains `SPECIES_DIALGA` with the chosen ability `ABILITY_TEMPORAL_RUPTURE` and
`MOVE_ROAR_OF_TIME` (it resolves to `SPECIES_DIALGA_ORIGIN` in play). No other Drake mon has an
undo move and nobody has an Unaware ability.

- Turn 1: `team:support` -> Kingdra in both logged games. Predicted move Steel Beam, 83/235 on
  Kingdra (35.3%, acceptable); executed hit 76-79. Not a boost turn.
- Logged games: the only boost turns are Mr. Mime at turn 8 in both, `support:pivot` Baton Pass,
  `threatened=true` (`MOVE_DRAGON_ASCENT` / `MOVE_V_CREATE`) and `koThreat=true`. Dialga had
  fainted by then (it is the fight's first mon), so the undo scan was empty; this turn is the same
  support gate as Sidney, not the bug.
- **The undo bug's observable effect** (replay games 3, 5, 7 at turn 4): Mr. Mime is in while
  Dialga is alive and the position is safe (`threatened=false` at 25/50/75%, koThreat false,
  predicted Aura Sphere), stage 0, bench 1. Before the fix `opponentCanUndoBoosts` saw Dialga's
  `MOVE_ROAR_OF_TIME` and reported a phaze, so `chooseBatonPassSetup` returned null and
  `chooseSupport` Baton Passed with nothing. After the fix the same turn picks Calm Mind, and the
  next turn another Calm Mind at +1 -> +2, then the hand-off at turn 6. That is the fix's 6 uses in
  10 games.
- Aggregate after the fix: 19 boost turns, 6 used, 10 threatened, 3 already at the +2 target.

## Glacia stall (the only sweeper)

Rhyperior (`sweeper` -> `setupSweeper`) with Swords Dance. 10 replay games, 38 boost turns, 0 uses.
On all 38 the predicted move (Ice Fang, Crunch, Blizzard, Gust) crosses the safety line at 25, 50
and 75%: Rhyperior's 4x Ice weakness and Glacia's special attackers make every entry unsafe. On
Rhyperior's first turn (T7 in eight games, T13 in two) `threatened=true`, `koThreat=false`, stage 0,
so `chooseSetupSweeper` (`rolePolicy.ts:1163-1175`) takes the `!view.threatened` branch out of play
and falls to `chooseAttacker`. Decision 14 as written ("boost while below the target stage, safe,
and the opponent's party has no Haze, phazing move or stage-ignoring ability") makes this correct:
the sweeper is never safe in this matchup, at any of the plan's three safety values.

Observation: by T8 the replay shows `stage=4` although Rhyperior never boosted. The stages are
Rhyperior's own Weak Armor Speed raises (+2 per physical hit). `currentBoostStage`
(`rolePolicy.ts:1077-1084`) counts any positive Attack/Sp. Atk/Speed stage, so a passive raise
satisfies the target stage and the sweeper would not Swords Dance even on a safe turn after one
physical hit. See question 5.

## Other fights (clean)

Phoebe / Glacia-attack / Steven also have no sweeper in the fixture; Mr. Mime is the only boost
carrier. Smoke run after the fix (3 role games each, not the 80-game measurement):

| Fight | used | available |
| --- | --- | --- |
| TRAINER_SIDNEY-attack | 0 | 5 |
| TRAINER_DRAKE-attack | 2 | 6 |
| TRAINER_GLACIA-stall | 0 | 12 |
| TRAINER_GLACIA-attack | 0 | 3 |
| TRAINER_PHOEBE-attack | 0 | 0 |
| TRAINER_STEVEN-attack | 0 | 3 |

Zero is an honest result for the reasons above; no rule was changed to move it.

## Root cause and fix

**Fixed — `opponentCanUndoBoosts` treated every `EFFECT_HIT_SWITCH_TARGET` move as phazing**
(`rolePolicy.ts:1097-1135`, previously 1081-1093). `BattleScript_EffectHitSwitchTarget`
(`data/battle_scripts_1.s:1669-1671`) is
`jumpifnotmove MOVE_ROAR_OF_TIME, BattleScript_EffectHitSwitchTarget_Continue` followed by
`jumpifability BS_ATTACKER, ABILITY_TEMPORAL_RUPTURE, BattleScript_EffectHit`, so a Roar of Time
from a Temporal Rupture holder is a plain hit and drags nothing out. The sim's switch handler
already applies that test (`turn.ts:5073-5085`). The fix skips `MOVE_ROAR_OF_TIME` for a holder
whose `battlerHasSimAbility(..., 'ABILITY_TEMPORAL_RUPTURE', false, battler.id, false, ...)`
(`statBuffs.ts:168`) is true, reading the live battler for the mon on the field and
`stateWithReserve(...).battlers[1]` for a reserve. The C's actor is `BS_ATTACKER` itself, so
Mold Breaker cannot matter (`BATTLER_HAS_ABILITY` is `BattlerHasAbility(..., TRUE)`,
`include/battle_util.h:73`, and `IsSuppressed`'s Mold Breaker clause excludes
`battler == gBattlerAttacker`, `battle_util.c:9254-9261`); Neutralizing Gas and Gastro Acid still
suppress it. Every other undo move and the Unaware abilities still block. Test:
`web/src/engine/sim/cycles20f1BoostUndoGate.test.ts` (6 cases: 3 fail before the fix, the 3 negative
cases pass before and after).

**Not fixed — the dominant blocker is a plan question, not a bug I could prove:** the support's
own-boost step uses the sweeper's `threatened` gate (`rolePolicy.ts:1408`), while decision 14 gives
`support` no safety parameter. That single line explains Sidney's 16/16 and 10 of Drake's 19.

## The turn-1 switch-in estimate (candidate 4)

In the committed logs (and the identical replay) turn 1 brings Kingdra into Alakazam's Dark Pulse
and loses 194/235 (82.6%) after a switch-in judged at 86/235 (36.6%, under the 50% line). The
prediction is computed against the pre-Mega mon: the decision-time battler is
`SPECIES_ALAKAZAM_REDUX` (ability `ABILITY_MINION_CONTROL`), and the log's turn 2 shows
`SPECIES_ALAKAZAM_MEGA_REDUX` — the AI Mega-evolves on its first turn, after the prediction. The
sampled move is the actual move (Dark Pulse), so this is not a different-move or role-mapping
error. The pre-Mega -> Mega Sp. Atk jump (135 -> 175, `species.json`) is about 1.3x and does not
account for 86 -> 194 on its own; the attacker is also a Minion Control (Parental Bond) user, whose
AI-side hit count `aiCalcDamage.ts:159-180` documents as an approximation. The sim's `ActionOutcome`
has no crit field, so these logs cannot separate a crit from the form change. Reported, not fixed:
decision 14 defers Mega timing.

## Design questions for Yoshi

1. **The support's own boosts are gated as if it were a sweeper** (`rolePolicy.ts:1408`). Decision
   14 gives `support` only a fallback-role gene and says "set its effect when it is not up ... or
   its OWN boosts to a target stage to pass with Baton Pass" with no safety condition. Options:
   (a) drop `view.threatened` for the own-boost step only (plan as written; Mr. Mime would boost
   through Sidney's Dark Pulses and likely faint early); (b) keep it and record it as an implicit
   support safety gene; (c) add it as the support's second GA parameter (at most 2 per role per the
   plan), defaulting to 50.
2. **Defense boosts do not count.** `isCountingStat` (`rolePolicy.ts:536-538`) keeps only Attack,
   Sp. Atk and Speed, so Iron Defense (`EFFECT_DEFENSE_UP_2`) is never a usable boost for the
   sweeper or the Baton Pass step. The comment says "(decision 14)", but the plan says only "boost
   while below the target stage" and names no stats. Options: (a) keep the three stats (a
   defense-boosting staller is a different role); (b) count every stat the move raises, so a mon
   with only Iron Defense sets up; (c) add a per-role stat gene.
3. **`supportEffectPending` excludes own boosts** (`rolePolicy.ts:1386-1388`), so the team layer's
   bring-in-support purpose never brings a Baton Pass support in to set up, although decision 14
   lists own boosts among a support's effects. The code's stated reason is sound (a freshly
   switched-in mon is at stage 0, so it would always read "pending"). Options: (a) keep it and read
   the plan's "bring in support" as field/side effects only; (b) include own boosts only when the
   support has Baton Pass and a live bench; (c) include them with a once-per-entry cap.
4. **Mega timing is not predicted.** The turn-1 switch-in is judged against the pre-Mega foe and
   the AI Mega-evolves the same turn (observed above). Options: (a) accept, as decision 14 defers
   Mega timing; (b) sample the prediction against the resolved Mega form too and keep the worse
   case for switch-in safety; (c) model the AI's Mega turn in the policy.
5. **`currentBoostStage` counts passive raises.** Weak Armor's Speed boosts reach +4 by turn 8 in
   the Glacia stall fight, so a safe turn would still read "at the target stage" and Swords Dance
   would never be picked after one physical hit. Options: (a) keep it ("below the target stage"
   literally); (b) count only stages this mon raised with a boost move since switch-in, as the gate
   report's own-boost definition already does; (c) ignore Speed stages for the target.

## Files

- Fixed: `web/src/engine/sim/driver/rolePolicy.ts` (`opponentCanUndoBoosts` + the
  `PHASE_OUT_EFFECTS` comment).
- Test: `web/src/engine/sim/cycles20f1BoostUndoGate.test.ts`.
- Not changed: `role-policy-gate-report.md`, `role-policy-logs/`, the fixture.
