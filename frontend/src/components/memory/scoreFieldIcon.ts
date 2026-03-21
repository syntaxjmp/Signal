/** Parses a numeric score from meta/API strings like "10.00" or "0". */
export function parseNumericScore(value: string): number | null {
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function severityToWarningIcon(severity: string): string {
  const s = severity.toLowerCase();
  if (s.includes("critical")) return "/critical_warning.png";
  if (s.includes("high")) return "/medium_warning.png";
  if (s.includes("medium")) return "/medium_warning.png";
  if (s.includes("low")) return "/low_warning.png";
  if (s.includes("info")) return "/low_warning.png";
  return "/medium_warning.png";
}

/**
 * Icon for a **Score** row: `check.png` at 0; warning icons when &gt; 0 (from severity hint when available).
 * Returns `null` if the value is not a plain number (caller falls back to plain text / file icon).
 */
export function scoreIconSrc(value: string, severityHint?: string): string | null {
  const n = parseNumericScore(value);
  if (n === null) return null;
  if (n === 0) return "/check.png";
  return severityToWarningIcon(severityHint ?? "");
}

export function isScoreMetaLabel(label: string): boolean {
  const norm = label.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "score" || norm === "weightedscore" || norm === "riskscore";
}

export function isScorePayloadKey(key: string): boolean {
  const norm = key.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return norm === "score" || norm === "weightedscore" || norm === "riskscore";
}
