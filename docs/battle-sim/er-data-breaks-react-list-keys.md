# Elite Redux data breaks React list keys

_Measured -- ER trainer parties repeat species and movesets repeat move ids, so species id, move id and speciesId+level are all unsafe React keys_

Never key a React list on a species id, a move id, or a species+level pair when the rows
come from `data/<version>/trainers.json`. Use the array index; these lists are fixed within
a render and never independently reordered.

Measured over `data/v2.65beta/trainers.json` on 2026-09-12 (932 trainers, do not re-derive):

| signal | count |
|---|---|
| trainers with a duplicate species inside one party tier | 23 (56 trainer/tier pairs) |
| party mons with a repeated move id | 116 |
| trainers whose ace, elite and hell parties are ALL empty | 37 |
| ace-party mons with no usable move | 2 |

Worked examples: `TRAINER_NOB_5` fields six SPECIES_HAPPINY in every tier;
`TRAINER_DAISY`'s Alcremie carries MOVE_METRONOME four times; `TRAINER_ETHAN_5` has no
party at all in any tier. The player side collides too -- `BattlerPanel`'s four move slots
are independent selects with no duplicate check, so a user can pick one move twice.

**Why:** these ids read like natural keys and are not. Duplicate sibling keys make React's
reconciliation undefined -- rows can be dropped or mis-updated when an input above the list
changes.

**How to apply:** grep the diff for `key={` in anything rendering a trainer party, its
speed tiers, or a moveset, and check each against this table. The all-empty and no-move
rows are also the empty-state cases to ask about: they must render a message, not a bare
header. See [What the React layer's checks do and do not catch](react-layer-review-gates.md).

## Trainer identity fields (measured 2026-09-13, do not re-derive)

The **trainer `id` IS unique** and is the one safe natural key on a trainer row: 932
trainers, 932 distinct ids, 0 duplicates. Everything human-readable collides.

| signal | count |
|---|---|
| distinct (name, class) pairs | 539 |
| pairs shared by 2+ trainers | 94 |
| trainers inside those shared pairs | 487 of 932 |
| distinct names | 527 (97 shared by 2+) |

Largest groups: Grunt/TEAM MAGMA = 30, Grunt/TEAM AQUA = 26, May/PKMN TRAINER 3 = 18,
Brendan/PKMN TRAINER 3 = 18. Tate&Liza/LEADER = 5, all rendering identically. So any
trainer UI that shows only name and class is ambiguous for **more than half** the roster,
and `key={t.id}` on a trainer list is correct where `key={speciesId}` on a party is not.
