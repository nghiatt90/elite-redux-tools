import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(__dirname, '..')
const repoDataDir = path.resolve(webDir, '..', 'data')
const publicDataDir = path.resolve(webDir, 'public', 'data')

const VERSIONS = ['v2.65.5', 'v2.65.4.1b', 'v2.65beta']
const BASE_VERSION = 'v2.65.5'
const JSON_FILES = [
  'abilities.json',
  'abilityHooks.json',
  'items.json',
  'meta.json',
  'moveBehaviors.json',
  'moves.json',
  'natures.json',
  'species.json',
  'types.json',
]

console.log('Cleaning public/data...')
await fs.rm(publicDataDir, { recursive: true, force: true })
await fs.mkdir(publicDataDir, { recursive: true })

let totalFiles = 0

for (const version of VERSIONS) {
  const versionSrcDir = path.join(repoDataDir, version)
  const versionDstDir = path.join(publicDataDir, version)
  await fs.mkdir(versionDstDir, { recursive: true })

  // 1. Copy JSON data files
  for (const jsonFile of JSON_FILES) {
    const src = path.join(versionSrcDir, jsonFile)
    const dst = path.join(versionDstDir, jsonFile)
    await fs.copyFile(src, dst)
    totalFiles++
  }

  // 2. Sprites & overrides
  const baseSpritesDir = path.join(repoDataDir, BASE_VERSION, 'sprites')
  const versionSpritesSrc = path.join(versionSrcDir, 'sprites')
  const versionSpritesDst = path.join(versionDstDir, 'sprites')
  const overridesFile = path.join(versionDstDir, 'spriteOverrides.json')

  if (version === BASE_VERSION) {
    await fs.cp(baseSpritesDir, versionSpritesDst, { recursive: true })
    // Count sprites copied for base version
    const speciesDirs = await fs.readdir(versionSpritesDst, { withFileTypes: true })
    let baseSpriteCount = 0
    for (const dir of speciesDirs) {
      if (dir.isDirectory()) {
        const files = await fs.readdir(path.join(versionSpritesDst, dir.name))
        baseSpriteCount += files.filter((f) => f.endsWith('.png')).length
      }
    }
    totalFiles += baseSpriteCount
    await fs.writeFile(overridesFile, JSON.stringify([], null, 2) + '\n')
    totalFiles++
    console.log(`Synced ${version}: ${JSON_FILES.length} JSONs, ${baseSpriteCount} sprites, 0 overrides`)
  } else {
    const overrides = []
    await fs.mkdir(versionSpritesDst, { recursive: true })
    const speciesDirs = await fs.readdir(versionSpritesSrc, { withFileTypes: true })
    let spriteCount = 0

    for (const dir of speciesDirs) {
      if (!dir.isDirectory()) continue
      const speciesName = dir.name
      const srcSpeciesDir = path.join(versionSpritesSrc, speciesName)
      const baseSpeciesDir = path.join(baseSpritesDir, speciesName)
      const dstSpeciesDir = path.join(versionSpritesDst, speciesName)

      const files = await fs.readdir(srcSpeciesDir)
      for (const f of files) {
        if (!f.endsWith('.png')) continue
        const variant = path.basename(f, '.png')
        const srcFile = path.join(srcSpeciesDir, f)
        const baseFile = path.join(baseSpeciesDir, f)

        let differ = false
        try {
          const [srcBuf, baseBuf] = await Promise.all([
            fs.readFile(srcFile),
            fs.readFile(baseFile),
          ])
          if (!srcBuf.equals(baseBuf)) {
            differ = true
          }
        } catch {
          differ = true
        }

        if (differ) {
          await fs.mkdir(dstSpeciesDir, { recursive: true })
          await fs.copyFile(srcFile, path.join(dstSpeciesDir, f))
          overrides.push(`${speciesName}/${variant}`)
          spriteCount++
          totalFiles++
        }
      }
    }

    overrides.sort()
    await fs.writeFile(overridesFile, JSON.stringify(overrides, null, 2) + '\n')
    totalFiles++
    console.log(`Synced ${version}: ${JSON_FILES.length} JSONs, ${spriteCount} sprites, ${overrides.length} overrides`)
  }
}

console.log(`sync-data complete: total files in public/data = ${totalFiles}`)
