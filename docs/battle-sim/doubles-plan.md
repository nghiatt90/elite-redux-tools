# Plan: doubles, two-opponent and multi battles in the battle simulator (D1 + D2)

_Status: APPROVED by a cold Opus reviewer after 2 rounds (round 1: NEEDS WORK, 4 blocking issues, all verified and fixed; round 2: APPROVED, 3 non-blocking edits applied). Not yet committed or executed. Vikunja task 60. Planning only: no sim code is changed by this document._

## Goal

Make the sim run the five mandatory non-singles fights of the 40-fight target set in their real format, with the
C's doubles AI, double-only damage terms and party layout, while leaving every singles result unchanged:

| Fight | Real format | Opponent trainer ids (elite party size) | Player side |
|---|---|---|---|
| Gym 7 Tate & Liza | plain double (`forcedDouble`), **inverse battle** (`FLAG_SYS_INVERSE_BATTLE` set at `MossdeepCity_Gym/scripts.pory:995`, cleared `:1019`), Trick Room, Tense Battle event (`:996`) | `TRAINER_TATE_AND_LIZA_1` (6) | player's own party, 2 active |
| Gym 8 Juan stage 1 | two opponents, no partner | `TRAINER_JUAN_1` (3) + `TRAINER_WALLACE` (3) | player's own party, 2 active |
| Gym 8 Juan stage 2 | same, chained after stage 1 | `TRAINER_JUAN_5` (3) + `TRAINER_WALLACE_5` (3) | same |
| Meteor Falls | `multi_2_vs_2` | `TRAINER_COURTNEY_METEOR_FALLS` (3) + `TRAINER_GRUNT_METEOR_FALLS` (3) | 3 chosen mons + AI partner `MAY_TORCHIC_METEOR_FALLS` (3) |
| Space Center 2F Maxie | `multi_2_vs_2` | `TRAINER_MAXIE_MOSSDEEP` (3) + `TRAINER_COURTNEY_MOSSDEEP` (3) | 3 chosen mons + AI partner `TRAINER_STEVEN_MOSSDEEP` (3) |

Opponent sizes are from `data/v2.65beta/trainers.json` (`parties.elite`; hell-tier parties of 4 are truncated to 3 under TWO_OPPONENTS,
`battle_main.c:1778-1782`, so the plan targets the elite tier). **Partner parties are NOT tiered**: `FillPartnerParty`'s custom-partner branch
reads `gTrainers[id].party` / `.partySize` (the base party, i.e. the `ace` tier in `trainers.json`), never the Elite/Hell parties
(`battle_tower.c:2399-2402`), with fixed IV 31, level = `GetHighestLevelInPlayerParty()` capped to 1..100 and no per-mon offset (`:2404-2412`).
Steven in the Space Center uses this custom branch too (`multi_2_vs_2 ... TRAINER_STEVEN_MOSSDEEP`, script `:274`), not `sStevenMons`
(that array belongs to `SPECIAL_BATTLE_STEVEN`, a different entry). Ace and elite differ for `TRAINER_STEVEN_MOSSDEEP`, so the tier matters. Fight list and script call sites are from
`docs/battle-sim/boss-fight-coverage.md:478-510` and the upstream scripts cited below.

## Context (verified facts the plan rests on)

### C: formats and setup
- Battler ids are positional: 0 player-left, 1 opponent-left, 2 player-right, 3 opponent-right
  (`src/battle_controllers.c:117-153`). `gBattlersCount` is 4 for any double or partner battle, 2 for singles (`:194`).
- Flag sets: two-trainer overworld approach `DOUBLE | TWO_OPPONENTS | TRAINER` (`battle_setup.c:1240`);
  `SPECIAL_BATTLE_TWO_OPPONENTS` the same (`battle_tower.c:1627-1628`); `SPECIAL_BATTLE_MULTI` 2-vs-2
  `TRAINER | DOUBLE | TWO_OPPONENTS | MULTI | INGAME_PARTNER` (`:1645-1647`); `SPECIAL_BATTLE_STEVEN` the same flags
  (`:1615-1616`, partner `TRAINER_STEVEN_PARTNER`). A single trainer becomes a double through
  `gTrainers[].doubleBattle` (`battle_main.c:1910-1913`): `isDoubleBattle` (`:1757-1762`; needs two usable player mons, an enemy
  party of at least 2, and `doubleBattleMode` or `doubleBattle`) sets `BATTLE_TYPE_DOUBLE`, but the `else` branch at `:1913` ORs
  `gTrainers[].doubleBattle` in anyway, so a forced double stays a double with only one usable player mon.
- The `starttagbattle` and `multi_2_vs_2` / `choose_mons` macro definitions are NOT in the pinned tree. So "Juan is
  `DOUBLE | TWO_OPPONENTS | TRAINER` with no MULTI/INGAME_PARTNER" is an inference from `battle_tower.c:1627-1628`
  and `environmentInventory.ts` (~:1378, :2920 already records the same gap). It is an explicit assumption, not a fact.
- Roster layout (C): a side has one 6-slot party. With two opponents, trainer A fills enemy slots 0-2 and trainer B
  slots 3-5 (`battle_main.c:613-615`, 3 mons each: `:1778-1782`); `MULTI_PARTY_SIZE` = 3 (`constants/global.h:80`). With a
  partner, the player's chosen mons are `gPlayerParty[0..2]` and the partner's are `[3..5]` (`FillPartnerParty`,
  `battle_tower.c:2363-2407`: at most 3 mons, level = highest player level, custom partners capped at 100).
  `GetMaxBattleEntries` is `MULTI_PARTY_SIZE` for the multi facility (`party_menu.c:5954-5957`).
- Starting party indexes with a partner: battlers 0,1 -> slot 0; battlers 2,3 -> slot 3 (`battle_controllers.c:160-171`).
  Without MULTI but with TWO_OPPONENTS: `SetBattlePartyIds` picks the first two valid player mons for battlers 0 and 2, and
  forces `gBattlerPartyIndexes[1] = 0`, `[3] = 3` (`battle_controllers.c:615-675`).
- Outcome: `Cmd_checkteamslost` (`battle_script_commands.c:3726-3730`). `NoAliveMonsForPlayer` counts only slots 0-2 when
  there is an INGAME_PARTNER (`:3686-3705`), so the player loses when their own three are down even if the partner lives.
  `NoAliveMonsForOpponent` sums all six enemy slots (`:3707-3719`). A two-opponent side whose trainer has no mons left marks
  that battler absent (`HasNoMonsToSwitch`, `battle_util.c:3607-3686`) and the fight continues; it does not take the other
  trainer's mons. Replacement prompts run in battler order 0, 2, 1, 3 (`Cmd_openpartyscreen`, `battle_script_commands.c:5198, 5226-5320`).

### C: AI in doubles
- `BattleAI_ChooseMoveOrAction` dispatches on `BATTLE_TYPE_DOUBLE` (`battle_ai_main.c:195-198`) to
  `ChooseMoveOrAction_Doubles` (`:341-440`): scores every live non-self battler as the target, picks a random best move per
  target, sets an ally target's best score to -1 when it is under 100 (`:408`), then picks the best target at random among
  ties (`:421-438`) and stores it in `aiChosenTarget`.
- AI flags are one value for the whole battle: opponent A's `gTrainers[].aiFlags`, or the fixed
  `CHECK_BAD_MOVE | TRY_TO_FAINT | CHECK_VIABILITY | CHECK_FOE` under TWO_OPPONENTS (`:144-147`), OR'd with
  `AI_FLAG_DOUBLE_BATTLE` when DOUBLE, TWO_OPPONENTS, `doubleBattle` or `doubleBattleMode` (`:152-154`). The partner reads the
  OPPONENT's flags; its own trainer's flags are never read.
- The partner is AI-controlled by the same scorer: `battle_main.c:3637-3638` computes `aiMoveOrAction` for every
  `IsBattlerAIControlled` battler (`battle_ai_util.c:469` is true for PLAYER_RIGHT under INGAME_PARTNER);
  `PlayerPartnerHandleChooseMove` reads it back (`battle_controller_player_partner.c:1528-1550`), `AI_TrySwitchOrUseItem` handles
  its switches (`:1517-1521`; `ShouldUseItem` is FALSE for it, `battle_ai_switch_items.c:1089-1090`), and its forced
  replacement uses `GetMostSuitableMonToSwitchInto` with a fallback to the first live slot in 3-5 (`:1557-1590`).
- `AI_DoubleBattle` is `battle_ai_main.c:2214-2513`; the other scorers have only two doubles lines
  (`AI_CheckViability` `:2556`, `:2997`). `src/battle_ai_util.c` has `IsDoubleBattle()` gates at ~14 helper sites
  (`:1258, 1890, 2191, 2271, 2296-2367, 2408, 2515`).
- `SetRandomTarget` in doubles picks `Random() % 2` of the foes and flips on a dead one (`battle_util.c:6326-6341`).

### C: double-only damage terms
- Spread: `GetMoveTargetCount(...) >= 2` -> x0.75 (`battle_util.c:7498`; count at `:6761-6781`).
- Screens: x0.66 under `BATTLE_TYPE_DOUBLE`, else x0.5 (`:7622-7629`).
- Target's ally Friend Guard / Caretaker / Food Lovers: x0.5 each, `UQ_4_12(0.5)` (`:7638-7640`).

### Sim: what exists and what is missing (file:line from a read-only survey, 2026-11-14)
- `BattleState.battlers` is already indexed 0-3 with `battlersCount`, `absentBattlerFlags`, `battleTypeFlags` (`state.ts:680-707`);
  turn order loops `battlersCount` (`turnOrder.ts`); `executeTurn` takes one action per battler slot (`turn.ts:5045`, called with
  `[player, opponent, null, null]` at `driver/session.ts:442`); `getMoveTarget` is already a port of the C `GetMoveTarget`
  (`turn.ts:854-958`) and returns ONE battler; the partner helpers `^ 2` exist at the sites listed in the survey
  (`turn.ts:883,896,1777,2448,2457,4949`, `onWeather.ts:260-318`, `statBuffs.ts:318,990,1178`, `statusEffects.ts:1259`,
  `moveEnd.ts:1424,2493`, `endTurn.ts:1742,1776-1782`, `escape.ts:79`).
- Singles-only code: `chooseAiAction.ts:145-148,210` (battler 1 only, `battlerTarget = battlerAtk ^ 1`);
  `session.ts:182,216` and `buildMoveAction`; `runBattle.ts:55 defaultPlayerPolicy` and `expectimax.ts:1014,1060,1070,1107,1146`
  (battler 0 only, one opponent sample); about 60 raw `^ 1` sites outside tests (`switchInAbility.ts` 18, `moveEffects.ts` 16,
  `turn.ts` ~11, `moveEnd.ts` 8, `statBuffs.ts` 6, `endTurn.ts` 6).
- No multi-target loop: `executeAction` (`turn.ts:2289`) runs one `runMovePipeline(move, move, targetId)` (`:2629, :4604`), and
  `ActionOutcome` has one `targetId`/`targetDamage` (`turn.ts:376`). `moveEnd.ts:1404 adjustFollowupMoveTarget` collapses BOTH /
  FOES_AND_ALLY to one target.
- Damage bridge: `bridge.ts:637` hard-codes `isDoubleBattle: false`; `engine/types.ts:298` types it as the literal `false`;
  `finalDamage.ts:105` applies x0.75 when `isMultiTarget` but nothing sets it; `finalDamage.ts:126` already switches screens to
  0.66; `finalDamage.ts:46-47,131-132` loops `allyDamageReducerCount` at **0.75** where the C is **0.5** (`battle_util.c:7638-7640`)
  and nothing sets the count. `engine/multiHit.ts:155` notes the doubles target-count block is skipped.
- Roster/outcome: `SideState.party` is one roster per side (`state.ts:550-558`); `createBattleState` asserts the roster holds the active
  battlers (`create.ts:442-463`); `hasLiveReserve` (`switchIn.ts:115-119`), `firstLiveReplacement` (`session.ts:99`),
  `runBattle.ts:61-69` and `expectimax.ts:1050-1056` exclude only one battler's own `partyIndex`, so in doubles a partner's active mon
  could be chosen as a "reserve"; `outcome.ts:67-91` is side-level and its header says the INGAME_PARTNER slot-range case is
  unreachable (`:27-29`); `playerReplacement(state)` takes no battler id (`session.ts:214-218`).
- AI dead code: `isValidDoubleBattle` (`aiCheckBadMove.ts:243-247`) is always false and roots 7 partner stubs
  (`:554-586`) plus 14 inline dead branches; `aiCheckViability.ts` has ~12 gated sites (`:1288,1330,1518,1683,2575,2658,2992,3014,3132,3140,3180,3277`);
  `aiShouldSwitch.ts:106,453`; `aiSwitching.ts:259-260` THROWS for doubles/multi flags; `aiPipeline.ts:76-97`
  `setRandomTargetSingles` skips the `Random() % 2` branch. `ChooseMoveOrAction_Doubles` and `AI_DoubleBattle` are not ported.
- Fight spec today is one `TrainerData` (`runBattle.ts:15-23`, `session.ts:238-282`). `loadSimData.ts` loads only `battleEvents`,
  not `tagBattles` / `fieldEffects`. `bossSet.ts` deliberately drops partner ids (`TRAINER_STEVEN_MOSSDEEP`).
  `forcedDouble` is read only by `aiFlags.ts:98`. `solver.md:59-60` says doubles are out of scope.
- Known doubles-only gaps already recorded on Vikunja task 60 (comment 186): Focus Punch power must read the round's damage from any
  source (`damageResolver.ts:153`, `aiCalcDamage.ts:213` vs `battle_util.c:6851`); on-hit attacker abilities must use
  `ShouldApplyOnHitEffect` per round (`moveEnd.ts` ~4380-4960 vs `battle_util.c:4058-4062`); Future Sight countdown must run
  `HandleFaintedMonActions` between holders (`turn.ts runFutureSightCountdown`).

## Design decisions

1. **Mirror the C roster layout, do not invent one.** Each side keeps ONE 6-slot party. Two opponents: trainer A in 0-2, B in 3-5.
   Player with a partner: chosen mons in 0-2, partner in 3-5. 2-vs-1 style (Juan/Wallace are two TRAINERS vs one player, so this
   is TWO_OPPONENTS, not 2-vs-1): the player's own party in 0-5. This lets every existing `sides[x].party[partyIndex]` read stay
   valid, and the C's slot-range rules (`HasNoMonsToSwitch`, `NoAliveMonsFor*`, `GetAIPartyIndexes`) transcribe directly. Per-battler
   party ownership is a derived function `(state, battlerId) -> [firstSlot, lastSlot)`, not new state.
2. **A fight is a `BattleFormat`, not a trainer id.** `{ opponents: TrainerData[] (1|2); partner?: TrainerData; forcedDouble;
   inverseBattle; fieldEffects[]; battleEvents[]; playerPartyCap? }`, from which `battleTypeFlags` and the starting `partyIndex` layout are
   computed using the C rules quoted above. Singles remains `{opponents:[t]}` and must produce a bit-identical state to today. A forced
   double is a double even when the player has only one usable mon: `battle_main.c:1910-1913` ORs `gTrainers[].doubleBattle` into the flags
   outside the `isDoubleBattle` gate (`trick-room-and-forced-double-facts.md:15`); `buildBattleState` copies that.
   **Per-battler trainer lookup**: today `ChooseAiActionDeps.trainer` and `BattleSession.trainer` are one `TrainerData` (`session.ts:52,191,211,395,406`;
   `chooseAiAction.ts:139-142`; `createAiOpponentReplacement`). Replace with `trainerForBattler(format, battlerId)`: battler 1 -> `opponents[0]`,
   battler 3 -> `opponents[1]` (or `opponents[0]` when one opponent fields two battlers), battler 2 -> the partner's data when there is a partner;
   the AI flags stay the single battle-wide value (`state.aiFlags`).
   **Player party for multi fights**: the caller supplies the 3 chosen mons (`playerPartyCap = 3`; in the game `choose_mons` lets the player pick,
   `MeteorFalls_1F_1R/scripts.pory:164`, Space Center `:268`). The solver's team search for M3 therefore searches a 3-mon team. Enemy and partner
   levels are the highest level among those 3 (the game reduces the party first, then `GetHighestLevelInPlayerParty` runs; confirm in step 0.3).
   For Tate & Liza and Juan/Wallace the player brings the whole party and levels use the full party.
3. **Staged by fight, easiest first, each stage shippable and gated on unchanged singles output.**
   M1 Tate & Liza (one trainer, plain double, Trick Room, inverse chart, Tense Battle event): needs the 4-battler turn loop, spread/ally targeting, doubles AI, no
   partner and no second trainer. M2 Juan/Wallace: adds TWO_OPPONENTS rosters, shared AI flags, absent-battler rule, and a
   two-active-mon player side with no partner. M3 the two `multi_2_vs_2` fights: adds the partner AI, the 3-mon player cap,
   the slot-range outcome rule, partner-side replacement.
4. **Solver for a two-mon player side** (this is the one choice that changes cost): the player's action space is the joint
   choice of two battlers (each: a move with a target, or a switch). Recommended: keep expectimax over JOINT choices but prune each
   battler's list to its top K (default K=4) moves by the existing heuristic before forming the cross product, and keep the existing
   `DEFAULT_EXPECTIMAX` samples/depth until measured. Alternative (rejected for now): drive battler 2 with the partner AI and search only
   battler 0 - it is cheap but it makes the player's second mon play like an AI ally, which is wrong for Tate & Liza and Juan/Wallace
   where the player controls both. The multi fights DO use the partner AI for the partner, that is the C behaviour.
5. **Verification discipline is the repo's existing one**: every ported branch cites its C line; tests carry hand-derived numbers from
   the C plus a negative case; audits are lower bounds; a name in the code is not proof of a port. The `environmentInventory.ts` units
   for `BATTLE_TYPE_DOUBLE`, `BATTLE_TYPE_TWO_OPPONENTS`, `BATTLE_TYPE_INGAME_PARTNER` and `forcedDouble` must flip to ported with a
   production line that writes `battlersCount`/flags (`environmentInventory.test.ts:888-899`).

## Steps (each is one or more queue items; sizes follow the "split agent work small" rule)

### Step 0 - verify the unverified inputs (read-only, before any code)
0.1 Confirm that `trainers.json` `parties.ace` is the base `gTrainers[].party` that `FillPartnerParty` reads (compare against the codegen
    `eliteredux-source:tools/codegen/` output rules and `emit.py`), and record the partner mons (ace tier) for `MAY_TORCHIC_METEOR_FALLS` and
    `TRAINER_STEVEN_MOSSDEEP`. The Space Center script `:274` is `multi_2_vs_2` with a `TRAINER_STEVEN_MOSSDEEP` partner id, i.e. the custom-partner
    branch (`battle_tower.c:2394-2412`); `sStevenMons` (`:2372-2393`) is the other special battle and is not used here.
0.2 Confirm the Juan `starttagbattle` flag set by checking how `secret_base.c:1162-1173` and the tag-battle spec consume
    `TAG_TEAM_WALLACE_JUAN`; if the macro cannot be found, record the assumption in `environmentInventory.ts` (the tag-to-flag
    link) and in this plan, and run M2 under the assumed flags. A wrong flag set changes only the AI flag source (`battle_ai_main.c:144-145`) and
    `HasNoMonsToSwitch` routing.
0.3 Confirm the multi player cap is 3 (`GetMaxBattleEntries`, `party_menu.c:5954-5957`) and what `MAX_FRONTIER_PARTY_SIZE` is for
    `ReducePlayerPartyToSelectedMons` (`script_pokemon_util.c:210-227`).
0.4 Meteor Falls partner is one of six ids (`MeteorFalls_1F_1R/scripts.pory:193-238`, by player gender (May/Brendan) AND starter); the coverage doc
    (`boss-fight-coverage.md:198-213`) settles only the starter and fixes `MAY_TORCHIC_METEOR_FALLS`. Record the gender assumption too; the six
    ids all have 3/3/3 parties (compare their mons in `trainers.json` and note any difference).
0.5 Confirm the Tense Battle event reaches the sim: `encounters.json` `battleEvents` has `BATTLE_EVENT_TENSE_BATTLE` for map `MossdeepCity_Gym`,
    script `MossdeepCity_Gym_EventScript_TateAndLiza` (guard null); check `battleEventSetup.ts` selects it for the Tate & Liza fight spec.

### Step 1 - double-only damage terms (pure engine, calculator-testable, no sim state)
1.1 Widen `engine/types.ts:298` to `boolean`; stop `bridge.ts:637` hard-coding false (derive from `battleTypeFlags & BATTLE_TYPE_DOUBLE`).
1.2 Port `GetMoveTargetCount` (`battle_util.c:6761-6781`) and set `isMultiTarget` (x0.75 at `battle_util.c:7498`). Note Sparkling Aria is
    special-cased to BOTH, and the count reads the DYNAMIC target flags (`GetBattlerBattleMoveTargetFlags`, so Expanding Force-style changes
    apply), not the move's static target; `moveTargetFlags.ts:65-109` already produces the dynamic 'BOTH'.
1.3 Change `allyDamageReducerCount` to a 0.5 multiplier and wire it from the bridge for Friend Guard, Caretaker, Food Lovers
    (`battle_util.c:7638-7640`); correct `finalDamage.ts:131` and its test. The 0.75 there is wrong against the C today. The C reads the
    ability through `BATTLER_HAS_ABILITY_AND_ALIVE(BATTLE_PARTNER(def), ..., TRUE)` (Mold Breaker-aware) and the three abilities are `breakable`
    (`abilities/impl/00-flags.ts:29,31`), so the bridge must honour the attacker's ignore-ability state.
1.4 Tests: each term in isolation and combined, with the numbers derived by hand from `battle_util.c:7490-7650`; negative cases (one
    target alive, Friend Guard fainted, singles, attacker with Mold Breaker).
1.5 Widening `engine/types.ts:298` reaches the calculator UI (`calculate.ts:1407`, `features/damageCalc/scenario.ts:375`, `lib/matchupReport.ts:131`);
    those keep passing `false` so the calculator stays singles. The AI's damage cache becomes per target (`AI_DATA->simulatedDmg[atk][target][move]`,
    `battle_ai_main.c:415-416`) in step 4.

### Step 2 - state, format and roster (M1 scaffolding)
2.1 `BattleFormat` type and `buildBattleState(format)`; compute flags and starting `partyIndex` layout per the C rules; singles path must
    produce a deep-equal state to the current `createSession`.
2.2 Slot-range helper `partySlotsFor(state, battlerId)`; fix `hasLiveReserve`, `firstLiveReplacement`, `runBattle.ts:61-69`,
    `expectimax.ts:1050-1056` to exclude every active `partyIndex` on the side and honour the slot range.
2.3 Replacement flow: order 0, 2, 1, 3; per-battler `playerReplacement(state, battlerId)`; absent-battler marking per `HasNoMonsToSwitch`.
2.4 Outcome: port `NoAliveMonsForPlayer`/`Opponent` including the partner slot-range rule; update `outcome.ts` header.
2.5 `createBattleState` assertion `assertRosterHoldsActiveBattlers` extended to the 4-battler layouts. Absent battlers (`absentBattlerFlags`) must read
    as `hp == 0` wherever the AI scans targets (`ChooseMoveOrAction_Doubles` skips only `hp == 0`, `battle_ai_main.c:354`).
2.6 Battle start with four leads: `applyBattleStartPass` and the lead switch-in abilities run for four battlers in speed / Trick Room order; a replacement
    re-entry mid-battle follows the same ordering.
2.7 Partner mons live on the player side, so the player's innate gate and ability randomizer apply to them (`GetInnateInSlot`, `battle_util.c:8799-8802`,
    `isPlayer` decided by side). `createSession` gates innates only for `playerParty` today (`session.ts` + `innateGate.ts`); gate the partner's mons with
    the same rule and cite it.

### Step 3 - the turn loop in doubles (M1)
3.1 Per-slot action selection in `session.stepTurn`: actions array filled for every active battler; `buildMoveAction` target selection for
    battlers 2 and 3 (no hard-coded `^ 1`); `SetRandomTarget` doubles branch (`battle_util.c:6326-6341`) with the sim RNG.
3.2 Spread loop in `runMovePipeline`: run hit, accuracy, protect, damage, secondary effects and move-end per target for BOTH /
    FOES_AND_ALLY / OPPONENTS_FIELD targets, with `ActionOutcome` carrying a target list; keep single-target outcomes bit-identical.
3.3 Audit the ~60 raw `^ 1` sites: classify each as "single foe by design", "needs all foes", or "needs the chosen target"; fix the last two
    classes with the C cited. The classification table is a deliverable of this step (committed under `docs/battle-sim/`) and the review checklist.
3.4 The three known gaps (Focus Punch any-source damage, `ShouldApplyOnHitEffect` per round, Future Sight faint handling between holders).
3.5 Follow Me / Rage Powder / redirection abilities at execution (`battle_util.c:262-329`) verified against the existing `getMoveTarget` port.

### Step 4 - doubles AI (M1)
4.1 Port `ChooseMoveOrAction_Doubles` (`battle_ai_main.c:341-440`) with per-target scoring, the ally -1 rule, random tie-breaks via the sim RNG.
4.2 Port `AI_DoubleBattle` (`:2214-2513`) and `AI_DATA->partnerMove` / `GetAllyChosenMove`.
4.3 Replace `isValidDoubleBattle` with the real `IsValidDoubleBattle` (`battle_ai_util.c:2270-2280`) and port the partner helpers
    (`:2295-2378`); then revisit each dead branch listed in the survey (CheckBadMove 7 stubs + 14 branches, CheckViability ~12, ShouldSwitch 2),
    removing the "always false" comments and adding a test that reaches each branch.
4.4 `chooseAiAction(state, battlerId)` for any AI battler (remove the odd-id throw at `chooseAiAction.ts:145`), reading trainer data through
    `trainerForBattler` (Design decision 2) instead of the single `deps.trainer`, `aiChosenTarget` per battler,
    opponent self-target mask (`battle_controller_opponent.c:1580-1611`, incl. BOTH -> player-left, falling back to player-right when absent).
4.5 `battleAiSetupFlags` for TWO_OPPONENTS (fixed flag set, `battle_ai_main.c:144-145`) and the shared-flags rule.
4.6 `aiSwitching.ts:259-260`: replace the throw with the multi-battle `GetMostSuitableMonToSwitchInto` branch
    (`battle_ai_switch_items.c:985-996`) and `GetAIPartyIndexes` slot ranges (`:30-47`).

### Step 5 - driver, fight specs and M1 end to end
5.1 `loadSimData` loads `tagBattles`, `fieldEffects` and `inverseBattles`; `RunBattleOptions`/`SessionOptions` take a `BattleFormat`. `session.ts:130`
    (`aiDamageDepsFor`, the AI's scoring), `:201` and `:232` stop hard-coding `inverseBattle: false` and read the format; the Tate & Liza flip
    test covers both a damage-resolver number and an AI score.
5.2 Fight specs for the five fights. Sources per field: Juan stage 1 and 2 opponent pairs from `encounters.json` `tagBattles`
    (`TRAINER_JUAN_1`+`TRAINER_WALLACE`, guard `!flag(FLAG_BADGE08_GET)`; `TRAINER_JUAN_5`+`TRAINER_WALLACE_5`, script `Juan_Battle_2`); Tate & Liza
    Trick Room from `fieldEffects` and inverse from `inverseBattles` (both `TRAINER_TATE_AND_LIZA_1`, guard null) plus the Tense Battle event; the two
    `multi_2_vs_2` fights from the scripts and `boss-fight-coverage.md` because `encounters.json` has no rows for them. None of the five is in
    `trainerChains`. Tate & Liza therefore needs the inverse type chart (the sim already has `inverseTypeChart` in `aiDamageDepsFor`, `session.ts:124-138`)
    and a test that a type matchup flips.
5.3 Player policy for two battlers: `defaultPlayerPolicy` and the heuristic replacement per battler; expectimax joint choices with top-K pruning
    (Design decision 4). Retune samples/depth only after measuring.
5.4 Smoke: Tate & Liza runs to an outcome with a fixed seed; `smoke.test.ts` for singles unchanged.

### Step 6 - Juan/Wallace (M2) and the multi fights (M3)
6.1 TWO_OPPONENTS roster + the absent-battler rule. Juan stage 1 -> stage 2 has no heal between them (`SootopolisCity_Gym_1F/scripts.pory:308-311`,
    `FLAG_SYS_DISABLE_AUTOHEAL`); the chain stays a D3 dependency. Until D3 lands M2 runs each stage as a fresh full-HP fight, which OVERSTATES the
    win probability for stage 2, and solver output for stage 2 must say so explicitly (like the top-K caveat). `TRAINER_JUAN_5` is itself
    `forcedDouble: true`; with TWO_OPPONENTS it is a double regardless.
6.2 Partner controller: partner AI uses the opponent's AI flags, `PlayerPartnerHandleChooseMove` target rules, no items, partner switches.
6.3 3-mon player cap, partner in slots 3-5 built from the BASE (ace) party at level = highest of the chosen 3, IV 31 (Step 0.1, `battle_tower.c:2399-2412`).
6.4 `bossSet.ts` keeps dropping partner ids from the opponent union but the fight spec carries them.

### Step 7 - docs and inventory
7.1 Update `plan.md` step 6, `solver.md:59-60`, `boss-fight-coverage.md`, `environmentInventory.ts` units and docs, STATE.md D1/D2 lines
    (pointer to this file; D1/D2 become queue items per step above).

## Verification
- Gate at every step: `npx tsc -b web`, the full vitest suite, `npm run build`, both sim audits (`validate.sh` one-liner) with singles outputs
  unchanged; the audit counts are lower bounds and are never read as proof of a port.
- Per-feature: tests with hand-derived numbers from the cited C lines, each with a negative case; with/without comparisons that fail when the engine
  call is un-wired (the repo's recurring-defect note in `docs/battle-sim/trick-room-and-forced-double-facts.md:24-29`).
- Singles regression: deep-equal `createSession` state, identical seeded `runBattle` results before and after Step 2.
- Fight-level: each of the five fights runs to an outcome on a fixed seed and the trace shows two active battlers per side, correct targets,
  spread x0.75 where two foes are alive, partner AI moves in M3, and the correct winner when only one side's three own mons are down.

## Risks / open questions
- **Unverified C inputs**: the `starttagbattle`, `multi_2_vs_2`, `choose_mons` macro bodies are absent from the tree, so Juan's flag set and the exact multi party cap are assumptions
  (step 0.2/0.3); and `trainers.json` `parties.ace` being the base `gTrainers[].party` is checked in step 0.1 (the partner tier itself is settled: base party,
  highest chosen player level). Step 0 resolves or records each as an explicit assumption.
- **Size**: the turn loop has no multi-target concept and ~60 `^ 1` sites; Step 3 is the largest and riskiest. The AI port (Step 4) adds ~300 lines of
  `AI_DoubleBattle` plus ~30 dead-branch sites. Expect the work to span many driver cycles.
- **Solver cost** with two player battlers (Design decision 4): joint action space grows multiplicatively; top-K pruning is a heuristic and may
  miss optimal lines. Win probability for these five fights should carry that caveat in solver output.
- **Statistical, not bit-exact**: `Random() % 2` and tie-breaks use the sim RNG, so doubles AI target choices match in distribution only.
- **Double Battle Mode** (`option_plus_menu.c:1038`) is assumed off (`boss-fight-coverage.md:519-522`); with it on every trainer with 2+ mons is a double
  and all 40 fights change. Not planned.
- **Out of scope**: optional Gym 8 two-on-one branches (rematch rows JUAN_2..5), Battle Tower/Frontier formats, 2-vs-wild, link battles, full D3 chains,
  D5/D6.
