/** Zero-padded to at least 4 hex digits (0x0000 style) -- values above 0xFFFF (none
 * currently exist; max species id is in the low thousands) just grow past 4 digits
 * naturally rather than truncating.
 */
export function formatHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
}
