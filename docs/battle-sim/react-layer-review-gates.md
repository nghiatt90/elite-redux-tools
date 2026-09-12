# What the React layer's checks do and do not catch

_Run oxlint by hand on every React-layer review -- build and vitest cannot catch rules-of-hooks or any render-time defect in this repo_

For any batch touching `web/src/features/**` or `web/src/routes/**`, run
`npm --prefix web run lint` (oxlint) explicitly. Nothing else in the repo will catch a
render-time defect.

**Why:** lint was wired into `build` on 2026-09-13 (commit 8a398cd, now `tsc -b && npm run lint && vite build`), but before that it was NOT part of it,
so a rules-of-hooks error builds clean and deploys to Cloudflare Pages. `vite.config.ts`
sets `environment: 'node'` with `include: ['src/**/*.test.ts']` and no jsdom installed, so
there is no DOM test environment and `.tsx` files are not even collected. `tsc` passes on
hook-order bugs. In the 2026-09-12 matchup-report UI batch, `TrainerMatchup.tsx` called
`useMemo` after two `if (status === ...) return` early returns -- a guaranteed crash the
moment data loaded, invisible to `tsc -b` and to all 775 passing tests, and reported by
oxlint as an `error`.

**How to apply:** lint before reading the diff, not after. The precedent for a route's
loading/error gate is `routes/DamageCalculator.tsx`, which early-returns but calls no hook
afterwards (its children own their hooks); a route that memoizes must hoist the memo above
the gate and guard inside it. Also note there is no DOM environment, so state plainly in
the verdict that rendering was never observed. See
[Elite Redux data breaks React list keys](er-data-breaks-react-list-keys.md) and [Verifying cited numbers and corpus claims](verify-cited-numbers-and-corpus-claims.md).
