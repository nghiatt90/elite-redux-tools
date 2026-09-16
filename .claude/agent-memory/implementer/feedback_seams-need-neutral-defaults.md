---
name: seams-need-neutral-defaults
description: An unported input only gets a default when the default is the NEUTRAL answer; when the wrong answer is invisible (like grounding) make it a required seam instead
metadata:
  type: feedback
---

When a port needs an input it cannot yet derive, check what the default would mean before
choosing one. A default is safe only when it is the **neutral** answer — the effect is
absent, so the error is "less happens" and shows up as a missing behaviour someone will
notice. Ability contributions, hold effects and Trick Room are all like that.

An input whose plausible defaults are all *wrong for some battlers* is not like that. In
`turnOrder.ts` the first port gated Swamp on its timer alone, skipping
`IsBattlerGrounded` (`battle_main.c:4208`). That is not a missing effect; it is a wrong
number for every Flying-type, with nothing to notice it through. Make those a required
method on the context with no default, and have the neutral test context answer the
majority case **explicitly**, so it is wrong loudly rather than quietly.

**Why:** the team lead asked for this distinction written down as three lines of prose
rather than a comment, precisely because the next person adding an input to that interface
needs the rule, not the instance.

**The type requirement is not the protection.** Making it a required method only bites a
caller building a context from scratch, and a `NEUTRAL_*_CONTEXT` constant is the path of
least resistance — spreading over it to get the other defaults silently takes the wrong
grounding with them. So also write, on the neutral constant itself, that a real battle
must not use it. State the constraint where the consumer will meet it, not only where the
field is declared.

**How to apply:** before adding a field to a `*Context` seam, ask "if a caller supplies
nothing, is the result an absent effect or a wrong number?" Absent effect → give it a
default. Wrong number → no default, AND a warning on the neutral constant. See
[[turn-order-is-a-packed-bitfield]].
