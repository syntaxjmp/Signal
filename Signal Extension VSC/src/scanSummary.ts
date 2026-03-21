import type { Finding, WorkspaceScanSummary } from './types';

const SEV_WEIGHT: Record<string, number> = {
  critical: 15,
  high: 10,
  medium: 6,
  low: 2,
  info: 2,
};

/** Client-side summary when the API omits `summary` (older servers). */
export function deriveWorkspaceSummaryFromFindings(
  findings: Finding[],
  scannedFilesCount: number,
): WorkspaceScanSummary {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalWeight = 0;
  for (const f of findings) {
    const sev = f.severity;
    if (sev === 'critical') severityCounts.critical += 1;
    else if (sev === 'high') severityCounts.high += 1;
    else if (sev === 'medium') severityCounts.medium += 1;
    else severityCounts.low += 1;
    totalWeight += f.weightedScore ?? SEV_WEIGHT[sev] ?? 2;
  }
  const severityPressure =
    severityCounts.critical * 4 +
    severityCounts.high * 2 +
    severityCounts.medium * 0.5 +
    severityCounts.low * 0.1;
  const riskIndex = totalWeight + severityPressure * 8;
  const securityScore = Math.max(0, Math.min(50, Math.round(50 * (1 - Math.exp(-riskIndex / 80)))));
  return {
    scannedFilesCount,
    totalFindings: findings.length,
    severityCounts,
    securityScore,
    totalWeightedScore: totalWeight,
  };
}
