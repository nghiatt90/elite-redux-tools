#!/usr/bin/env node
// Cross-platform replacement for the old package.json one-liner:
//   rm -rf public/data && mkdir -p public/data && cp -r ../data/v2.65beta public/data/
// That failed on Windows: npm runs package.json scripts through cmd.exe there
// regardless of which shell invoked npm itself, and none of rm/mkdir -p/cp -r are
// cmd.exe builtins -- a real, reported blocker (the dev server had no data to serve,
// and `npm run build`'s own prebuild hook failed the same way). fs.rmSync/cpSync are
// plain Node APIs with no shell involved, so this needs no OS branching at all.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Matches sources.lock.json's game_version and lib/data.ts's own DATA_VERSION --
// three places carrying the same literal, same as before this rewrite; not fixed
// here, out of scope for "make the copy itself work on Windows". That triplication
// is exactly how a stale/mistyped version here would go unnoticed, which is why the
// existence check below runs before anything gets deleted, not after.
const DATA_VERSION = 'v2.65beta'

const webDir = dirname(dirname(fileURLToPath(import.meta.url))) // web/scripts/.. -> web/
const src = join(webDir, '..', 'data', DATA_VERSION)
const destRoot = join(webDir, 'public', 'data')
const dest = join(destRoot, DATA_VERSION)

// Checked BEFORE the destination is touched -- an earlier version deleted destRoot
// first and let cpSync's own "no such file" throw afterward, which leaves
// public/data empty (not just stale) if DATA_VERSION drifts from what's actually on
// disk. A missing source is a real, reachable case, not a hypothetical one: it's the
// literal error this whole rewrite exists to fix, just triggered by a wrong version
// string instead of a broken shell.
if (!existsSync(src)) {
  console.error(`sync-data: no such directory ${src} -- check DATA_VERSION against data/`)
  process.exit(1)
}

rmSync(destRoot, { recursive: true, force: true }) // force: true -- fine if it doesn't exist yet
cpSync(src, dest, { recursive: true })
console.log(`synced ${src} -> ${dest}`)
