export interface AuditAllowance {
  effect: string // move effect key as in moves.json, e.g. 'EFFECT_ALLY_SWITCH'
  reason: string
  citation: string // C location, e.g. 'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8855'
  // Exact audit notes this allowance covers. Omitted = every note of the effect, including notes the effect
  // gains later, so list `notes` whenever the effect could gain others: a new note is then uncovered and counted.
  notes?: string[]
}

export const AUDIT_ALLOWLIST: AuditAllowance[] = []

export function findAllowance(effect: string): AuditAllowance | undefined {
  return AUDIT_ALLOWLIST.find((a) => a.effect === effect)
}

export function validateAllowance(a: AuditAllowance): string[] {
  const problems: string[] = []
  if (!a.reason.trim()) problems.push(`${a.effect}: empty reason`)
  if (!/\.(c|cc|h|s|pory|inc):\d+/.test(a.citation)) problems.push(`${a.effect}: citation lacks file:line`)
  return problems
}

export function splitRows<R extends { effect: string; notes: string[] }>(rows: R[]): { counted: R[]; allowed: R[] } {
  const counted: R[] = []
  const allowed: R[] = []
  for (const row of rows) {
    const allowance = findAllowance(row.effect)
    if (!allowance) {
      counted.push(row)
      continue
    }
    const covered: string[] = []
    const uncovered: string[] = []
    for (const n of row.notes) (!allowance.notes || allowance.notes.includes(n) ? covered : uncovered).push(n)
    if (uncovered.length > 0) counted.push({ ...row, notes: uncovered })
    if (covered.length > 0) allowed.push({ ...row, notes: covered })
  }
  return { counted, allowed }
}
