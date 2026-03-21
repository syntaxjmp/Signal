/**
 * Ensures common id labels use a hash prefix (e.g. `Scan 6bfa6340` → `Scan #6bfa6340`).
 * Skips strings that already have `#` after the keyword.
 */
export function formatDisplayIdsWithHash(text: string): string {
  return text
    .replace(/\b(Scan\s+)(?![#])([a-fA-F0-9]+)\b/gi, "$1#$2")
    .replace(/\b(PR\s+)(?![#])([a-fA-F0-9]+)\b/gi, "$1#$2");
}
