export function formatHex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`
}
