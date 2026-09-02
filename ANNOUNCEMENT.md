# Introducing the Elite Redux Pokedex

A fast, searchable Pokedex built from Elite Redux's own game data — not guessed at,
not scraped, not stale. **[Try it now →](https://elite-redux-tools.pages.dev)**

If you've ever wanted to answer "which mons learn both Thunderbolt and Ice Beam and
have Levitate" without alt-tabbing between three tabs, this is for you.

---

## Search and filter, all at once

Type, base stat ranges, ability/innate, and now **moves** — filter by everything a
mon can learn, not just what it is. Every combination lands in the URL, so you can
paste a filtered view straight into Discord.

![Dashboard](docs/screenshots/dashboard.png)

## Click, don't navigate

On desktop, opening a species doesn't take you anywhere — the detail pane opens
beside the list, and your scroll position, search, and filters stay exactly where you
left them. Phones and tablets still get a clean full-screen detail view, since a
three-column layout on a 6" screen helps nobody.

![Split-pane detail](docs/screenshots/split-pane-detail.png)

## Mega and Primal forms, actually findable

They were always in the data — you just couldn't find them. Every mega and primal
form now shows up right in the evolution section of its base species.

![Mega and Primal forms](docs/screenshots/mega-evolutions.png)

## Abilities that actually explain themselves

Hover or tap any ability for the full mechanical breakdown. And for the "compound"
abilities that fuse several named abilities into one (looking at you, **Big Leaves**)
— you get every component's own explanation, not one vague summary. Mons whose
ability slots are genuinely all the same ability get one clean card instead of three
copies of the same text.

![Ability popover](docs/screenshots/ability-popover.png)

## Filters that respect uncertainty

Some abilities grant a whole extra type — Charmander's Half Drake adds Dragon, for
instance. That shows up as a distinct, dashed-border chip, both in results and on the
detail page, because only one ability is ever active at a time. It's a real
possibility, not a guaranteed third type.

![Filters](docs/screenshots/filters.png)

## Built for your phone too

Full-screen list and detail views, filters tucked into a bottom sheet, nothing
clipped or overlapping.

![Mobile list](docs/screenshots/mobile-list.png)
![Mobile detail](docs/screenshots/mobile-detail.png)

---

## What's next

**Team Builder** and **Damage Calculator** are next up — stubbed in the nav today so
you can see where they're headed.

Data is pinned to a specific Elite Redux commit and shown right in the footer, so you
always know exactly what version you're looking at.

**[elite-redux-tools.pages.dev](https://elite-redux-tools.pages.dev)** — unofficial,
built by the community, not affiliated with the Elite Redux dev team. Source at
[github.com/nghiatt90/elite-redux-tools](https://github.com/nghiatt90/elite-redux-tools);
see [README.md](./README.md) for the full feature list and how it's built.
