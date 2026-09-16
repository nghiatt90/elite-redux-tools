# Battle simulator and team-build solver: the plan

_Supersedes the draft at `~/.claude/plans/we-already-have-a-parsed-nova.md`. That document's
verified findings still hold and are cited from here; its scope, sizing and several of its
assumptions do not._

Written 2026-09-16. Everything measured here is against the committed `data/v2.65beta`
snapshot and the pinned checkouts in `pipeline/.upstream/` (SHAs in `sources.lock.json`).
**Re-measure after a repin.**

This lives in the repository on purpose. The previous plan lived outside it and went stale
repeatedly — it still described closed prerequisites as open and carried claims later proved
wrong — because nothing prompted anyone to read or update it. Corrections now land in the same
commit as the work that caused them.

## The goal, stated precisely

Given a player team and one of **40 specific boss fights**, decide whether that team wins and
what to change if it does not. Not a general battle simulator.

Four decisions fix the scope. They came from the user and are not open questions:

1. **Private and local.** The solver is for the user's own use. It does not ship, is not
   subject to the site's client-side constraint, and can take as long as a search needs. The
   Pokedex, damage calculator and matchup report stay as they are.
2. **40 fights, Elite difficulty only.** Listed and resolved to 55 trainer ids in
   [Boss-fight coverage](boss-fight-coverage.md). Ace and Hell are backlog.
3. **Statistically faithful, not bit-exact.** Model the mechanics correctly; do not reproduce
   the game's random number sequence call for call. Run many battles, report a win
   probability. This is the single largest scope reduction against the old plan, which was
   sized in months mostly because of exactness. See [What we give up](#what-we-give-up-by-not-being-bit-exact).
4. **No ROM oracle for now.** Building the game needs WSL, devkitARM, agbcc, a JDK and Kotlin,
   and a full clone. The user may set that up later. Until then, verification is against the
   decompiled C by reading and testing. [What that costs](#verification-without-a-rom) is
   stated below rather than glossed.

Save settings that act as fixed inputs: Double Battle Mode **off**, EVs **on**, level caps
**Strict**. Strict caps interact with Elite's player-only innate gating: below level 17 the
player loses their second innate and below 24 their third, while the AI keeps all three at any
level, so the earliest fights are played at a structural disadvantage. See
[Party level is not symmetric](er-level-asymmetries.md).

## What already exists

- **Data.** Species, moves, abilities, items, type charts including the inverse table, trainer
  parties with abilities resolved to what the ROM actually grants, and per-battle encounter
  data covering field effects, battle events, trainer chains, tag battles and the one inverse
  battle. All emitted and committed.
- **Damage engine.** A port of the game's damage path, with the ability registry, the crit
  path, base-power behaviours, Wonder Room, Inverse Room and the blend order all verified
  against the pinned source.
- **Matchup report.** Turn-one speed tiers, a two-way damage matrix, worst-case damage taken
  and what the AI believes its own damage is. Field effects and forced doubles disclosed.
- **Coverage measured.** Against the 40 fights: 4 move gaps of 344 damaging moves, no
  damage-relevant ability missing, and a named item list. The damage engine is close to done
  **for damage**. What remains is turn-loop work.

## The work, in order

Each step says what it buys and how it is checked. Steps are sequential where a later one
would otherwise be built on something wrong.

### 1. Correct the old plan and retire it

Short, and first because everything else is scoped from it. The old document still excludes
doubles by design, still lists the Room work as an outstanding prerequisite, still treats gym 8
as one trainer, and still sizes engine-widening on the assumption this plan replaces. Mark it
superseded, point it here, and correct the claims rather than deleting them, so the reasoning
survives.

Also correct `CLAUDE.md`, which says the battle-script directory is not fetched. It has been
fetched since `a97bc64`, and that stale line caused an agent to reason about move behaviour
from descriptions when it could have read the scripts.

### 2. Mega and primal form resolution

**70 of 285 party slots — a quarter of the Pokemon in these fights — hold a Mega Stone or a
Primal Orb** and change form during battle. Nothing models the change. The data is already
present: each mega form records the species it comes from and the item that triggers it.

First because everything later is wrong for a quarter of the opposing team without it, and
because it is mostly a lookup rather than new mechanics. Resolving it also grows the ability
union by 75, of which 29 are not yet ported.

**Checked by:** the resolved form's stats, types and abilities matching `species.json` for
every one of the 59 forms that appear, and the existing damage tests continuing to pass for
Pokemon that do not transform.

### 3. Battle state and the turn loop

The foundation. A review established that a slice restricted to damaging moves is not viable:
switching is reachable from inside the AI's own scoring, and its scores read state a damage-only
model does not have. Nine pieces of state must exist before the first turn is faithful: stat
stages, both status fields, the volatile-status structures, the reserve party with the
switch-target slot, side conditions and their timers, weather with field state and timers, held
item plus what has already triggered, revealed-move history, and the random source.

**Checked by:** per-mechanic unit tests against hand-derived cases read from the C, and
invariants that must hold across a turn regardless of outcome.

### 4. The AI as a policy

Port the live score functions. The AI computes its choice before the player's menu appears, so
from the player's side this is a single-agent problem against a policy that can be computed,
not a simultaneous-move game. Two traps are already documented: the AI's damage estimate uses
the maximum roll with no random spread, and it blanks the player's held item until that item has
triggered, so its estimate is knowably wrong in a way the report already exposes.

**Checked by:** transcription fidelity with every branch cited to its source line, plus
sensitivity analysis — if changing one AI choice changes the answer, that fight's result is
reported as fragile rather than as a number.

### 5. Turn-loop abilities and status moves

Now a bounded list rather than an open estimate: **140 abilities and 55 status moves** across
these 40 fights, named in [Boss-fight coverage](boss-fight-coverage.md). Entry effects,
end-of-turn effects, priority and accuracy modifiers, switch and faint triggers, hazards,
screens, recovery, protection, stat boosts. Port in batches, gated the way the ability registry
already is.

### 6. Doubles and multi battles

**Five of the 40 are mandatory doubles**, and two of those give the player an AI-controlled
ally with its own party. Gym 8 is two back-to-back two-on-one tag battles against Juan and
Wallace together. The engine excludes doubles by type, so this touches the state model
throughout. Deferred to here because the singles fights are the majority and nothing earlier
depends on it.

### 7. The solver

Search over moves, ability slot, held item, nature and EV spread, against a known opponent.
Prune hard against the specific fight rather than searching the full space. The opponent picks
the matchup when it switches, so the six-versus-six problem is not an assignment problem. Wrap
the whole search in the minimal-gym-subset loop, since clearing fewer gyms is preferred and
clearing more only removes opponent advantages.

## What we give up by not being bit-exact

Stated plainly, because it is the main risk this plan accepts.

Without matching the game's random sequence, **a subtly wrong AI decision does not announce
itself**. A bit-exact port can be diffed against the real game turn by turn; a statistical one
can only be compared in aggregate, and a policy that is wrong ten percent of the time still
produces a plausible-looking win probability. Mitigations, none of them equivalent to a diff:

- Every AI branch cites the source line it came from, so it is auditable by reading.
- Sensitivity analysis: report when an answer depends on a single AI choice.
- Report win probability with its uncertainty, never a bare verdict.

## Verification without a ROM

Everything is checked against the decompiled C by reading and testing. This project's own
history says what that is worth and where it fails: the config data has disagreed with the game
at least once, a test asserted a flag without checking it changed any number, and counts written
from reasoning rather than measurement have been wrong repeatedly. The standing rules that came
out of that apply here — implementer batches are reviewed before they commit, numbers in
comments are measured, and a claim is cited or it is not made.

If the user later builds the ROM, the highest-value use is not re-verifying damage, which is
already solid, but checking the AI's chosen move turn by turn on a shared seed. That is the one
thing reading cannot establish.

### How an oracle would actually be reached — **backlog, low priority**

Recorded because it is less impractical than it sounds, not because it is planned. The user's
position is that this probably will not happen.

You would not have to play to each fight. `src/debug.c` has a battle submenu that starts a
battle directly: it sets the format (singles, doubles, two opponents, and the multi format with
an in-game partner that two of these fights use), sets the terrain, sets the AI behaviour flags,
and calls `BattleSetup_StartTrainerBattle_Debug()` (`debug.c:1519-1573`).

Its limitation is the important part. **It does not take a trainer id.** It copies the enemy
party out of the player's party or a PC box (`debug.c:1548-1563`), so each opponent would have to
be rebuilt by hand — species, moves, ability, nature, EVs and held item, per Pokemon, per fight.
That is laborious and, worse, circular: the thing an oracle is most wanted for is confirming
that our reading of the trainer data is right, and this path requires asserting that reading as
the input.

The better shape is the one the old plan proposed: a small patch that starts a real trainer
battle by id through the ordinary entry point, so the game builds the party from its own tables.
Short, because that entry point already exists, and it removes the circularity.

Two things to check before trusting any diff produced this way, both answerable from source:
debug battles set `gIsDebugBattle`, and their AI flags come from `gDebugAIFlags` rather than the
trainer's own entry, so a debug battle is not automatically the same battle.

## Known unexplained

**Wally's second Victory Road fight.** The user is certain it fields Juan's three Pokemon as a
double battle. The map script and rematch table resolve unambiguously to a six-Pokemon singles
party. No mechanism was found. Recorded as unexplained rather than resolved toward the data; if
revisited, trace the Kotlin code generator rather than the textproto, which is exactly the shape
of [Textproto versus codegen divergence](textproto-vs-codegen-divergence.md).

Three scraper gaps are parked and inert on the current pin, documented in
[Encounters guard-field semantics](encounters-guard-field-semantics.md): innermost-only guards,
multi-line conditions, and stacked case labels. All three are safe because of what this
checkout happens to contain, not by construction. Re-check after a repin.
