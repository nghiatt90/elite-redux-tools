/** Zero-padded to at least 4 hex digits (0x0000 style) -- values above 0xFFFF (none
 * currently exist; max species id is in the low thousands) just grow past 4 digits
 * naturally rather than truncating.
 */
export function formatHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
}

/** A personality value, always the full 8 hex digits (0x000A94FD, never 0xA94FD).
 * PIDs are u32 and get pasted into save editors, where a short one is a *different*
 * value rather than a cosmetic difference -- so this pads to 8, not to "at least 4"
 * like `formatHex` does for the small ids it was written for.
 */
export function formatPid(pid: number): string {
  return `0x${(pid >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}
