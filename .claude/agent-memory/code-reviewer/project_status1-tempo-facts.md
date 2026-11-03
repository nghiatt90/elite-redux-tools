---
name: status1-tempo-facts
description: Settled C facts for valuing status1 in the solver leaf (sleep counter N = N-1 lost actions, freeze thaw is absorbing, frostbite halves SpA)
metadata:
  type: project
---

Settled while reviewing a8d068a (E1, solver status1 terms, 2026-11-03):

- Sleep: counter N costs **N-1** lost actions, not N. CANCELLER_ASLEEP (battle_util.c:3218-3243) subtracts
  first; reaching 0 takes the woke-up branch (effect=3), which does not cancel the move. Spore sets
  `Random() % 3 + 2` = 2..4 (battle_script_commands.c:2555; battle_config.h:56 "1-3 turns"). The sim's
  attackCanceller.ts:415-428 matches the C. Early Bird subtracts 2.
- Freeze: thaw clears STATUS1_FREEZE (battle_util.c:3255), so turn k is lost with probability 0.8^k, not 0.8.
- Frostbite halves SpA at battle_util.c:7145-7147, the exact parallel of burn's Atk halving at :7135.
- Paralysis: Hell mode disables the full-para cancel for the AI side (:3402); the sim does not model Hell mode.
- Toxic counter is never reset on switch in ER (no STATUS1_TOXIC_COUNTER clear outside cures).

**Why:** a worker encoded "counter = lost actions" and "each turn lost with p=0.8" as C-derived and wrote
tests asserting those numbers; the tests passed because they restated the formula.

**How to apply:** for any later term (E2-E4) that values a duration, trace the canceller/timer decrement
order in the C and in the sim before accepting the expected count. See [[derived-authority-is-not-authority]].
