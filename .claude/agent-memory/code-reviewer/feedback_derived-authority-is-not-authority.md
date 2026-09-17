---
name: derived-authority-is-not-authority
description: A claim that inherits its authority from another claim rather than from the source is indistinguishable from a verified one — covers self-referential tests and copied citations, both found 2026-09-17.
metadata:
  type: feedback
---

When something looks verified, ask **where its authority actually comes from**. A claim that
derives it from another claim, rather than from the source, reads exactly like a checked
fact and is structurally incapable of catching the error it is supposed to catch. Two forms,
both found in the bridge review on 2026-09-17, both flagged by the team lead as the same
underlying thing and worth generalising.

**Form 1 — a test that takes its expected value from the source under test.**
`unpack.test.ts`'s `expectExactlyBit(predicate, bit, label)` asserts the bit reads true and
both neighbours read false, which is a good helper. But the test imports `STATUS2_ENRAGED`
from `constants.ts` and passes it as `bit`. If that constant were `1 << 28` instead of
`1 << 29`, every assertion still passes — true case, both neighbours, empty word. The whole
bit suite is therefore blind to the one file that could break every predicate at once.
**Not specific to bitfields**: any test whose expected value comes from the same source as
the code under test has this shape. The fix is a literal, independently transcribed
expectation (`expect(STATUS2_ENRAGED).toBe(1 << 29)`, header line cited).

**Form 2 — a citation copied instead of re-derived.** `unpack.ts` cited
`battle_util.c:7707-7709` for the `FLAG_DMG_*` checks, which are at `:7680-7682`. The number
was copied from `engine/types.ts`'s existing doc rather than re-derived, so a single stale
citation propagated into a second file and a test comment, each new copy looking like
independent corroboration. Third instance of a well-formed citation pointing at wrong lines
in this repo. **The lesson is not "check citations"** — it is that copying one propagates an
error indistinguishable from a verified fact, and that three files agreeing is not three
checks when two of them are copies.

**Why:** both failure modes are invisible to the reviewer who only asks "is there a test?"
or "is there a citation?". The question that separates them is "was this checked against the
source, or against something that was?"

**How to apply:** when a test looks thorough, trace where its expected values come from and
flag any that share a source with the code. When several places cite the same lines, check
whether they are independent derivations or copies, and re-derive at least one from the
pinned checkout. Extends [[verify-cited-numbers-and-corpus-claims]], which covers verifying
the claim itself; this one is about verifying that the verification was real.
