import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Prose mentions an excluded rival, the player's multi-battle partner, and a trainer class constant.
const DROPPED_IDS = new Set([
  'TRAINER_MAY_LILYCOVE_TORCHIC',
  'TRAINER_STEVEN_MOSSDEEP',
  'TRAINER_CLASS_TEAM_MAGMA',
])

export function parseBossTrainerIds(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const startIdx = lines.findIndex((line) => line.startsWith('## The fights'))
  if (startIdx === -1) return []
  const endIdx = lines.findIndex((line, idx) => idx > startIdx && line.startsWith('## Unresolved'))
  const section = lines.slice(startIdx + 1, endIdx === -1 ? lines.length : endIdx).join('\n')

  const seen = new Set<string>()
  const result: string[] = []
  const push = (id: string) => {
    if (DROPPED_IDS.has(id) || seen.has(id)) return
    seen.add(id)
    result.push(id)
  }

  for (const match of section.matchAll(/TRAINER_[A-Z0-9_]+/g)) {
    const id = match[0]
    push(id)
    // The doc abbreviates `TRAINER_GRUNT_SPACE_CENTER_5/6/7`, so the regex only captures `_5`.
    if (id === 'TRAINER_GRUNT_SPACE_CENTER_5') {
      push('TRAINER_GRUNT_SPACE_CENTER_6')
      push('TRAINER_GRUNT_SPACE_CENTER_7')
    }
  }

  return result
}

export function loadBossTrainerIds(): string[] {
  const coveragePath = resolve(
    import.meta.dirname,
    '../../../../../docs/battle-sim/boss-fight-coverage.md',
  )
  return parseBossTrainerIds(readFileSync(coveragePath, 'utf8'))
}
