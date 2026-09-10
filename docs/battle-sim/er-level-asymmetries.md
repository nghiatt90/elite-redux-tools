# Party level is not symmetric

_Verified — party level is NOT symmetric between player and AI in Elite Redux; innate gating, level caps and EV dilution all penalise the player at low level_

Verified at the pinned SHA (2026-09-10). Enemy level = `GetHighestLevelInPlayerParty()`
(`battle_tower.c:2669`, used at `battle_main.c:1819`), so both sides share the
`(2*level/5 + 2)` damage term — but level is NOT neutral. Player-only penalties at low level:

- **Innates are level-gated for the player only.** `pokemon.c:4967-4971` and
  `battle_util.c:8800` short-circuit on `isEnemyMon` / `isPlayer`. Thresholds from
  `include/constants/pokemon_config.h:25-31`: Elite 1/17/24, Hell 10/17/24. Gate is
  `CanDisableInnates()` = `gameDifficulty >= DIFFICULTY_ELITE` (`pokemon.c:6235`).
  Below level 24 on Elite/Hell you lose innate 3; below 17 you lose innate 2. The AI keeps
  all three at any level.
- **Level caps are badge-gated.** `GetLevelCap()` `pokemon.c:4649-4671`, indexed by
  `getHighestBadge()`. Three tables selected by `gSaveBlock2Ptr->levelCaps`:
  `levelCapsStandard[] = {20,28,44,55,65,80,90,100,100,100}` (Easy),
  `levelCapsMore[] = {18,25,40,50,55,70,85,92,95,100}`,
  `levelCapsStrict[] = {16,23,36,45,50,55,60,70,80,100}` (Elite).
  So "minimise gyms cleared" and "party max level" are coupled dimensions, not independent,
  and how tightly depends on a save setting.
- **Enemy EVs need difficulty > EASY *and* the player's `enableEvs` setting.**
  `battle_main.c:1857` gates writing the config spread; `pokemon.c:996-997` then zeroes all
  six EVs when `!gSaveBlock2Ptr->enableEvs`, with no `isEnemyMon` exemption, and
  `CalculateEnemyTrainerMonStats` (`battle_main.c:1882`) runs it on the AI's party.
  DIFFICULTY_ACE = 1, so Ace-tier fights get the spreads *provided* EVs are on at all.
- **EVs get LESS impactful as level falls**, not more.
  Measured (base atk 130 vs base def 130, 100 BP, IV 31, neutral): 252 Atk EVs raise damage
  dealt by +19.8% at L100, +19.6% at L50, +16.7% at L30, +13.6% at L20.
  **Re-derived independently 2026-09-11 and confirmed exact** — see
  [Stat and damage formulas](er-stat-and-damage-formulas.md) for the working. One correction: the dilution is driven
  mainly by the damage formula's trailing `+2` and its truncation steps, not by the `+5` in
  CALC_STAT, which largely cancels between attack and defence.
- Player evolutions (`SpeciesList.proto:46 Evolution.level`) and level-up moves
  (`SpeciesList.proto:89 LevelUpMove.level`) are level-gated; the AI's species and 4-move set
  come verbatim from `TrainerList.textproto` regardless of level.

Net: lowering party max level is monotonically bad for the player. See
[Stat and damage formulas](er-stat-and-damage-formulas.md).
