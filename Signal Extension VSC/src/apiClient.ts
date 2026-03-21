import { deriveWorkspaceSummaryFromFindings } from './scanSummary';
import type { Finding, IndexedFile, SnippetScanPayload, WorkspaceScanResult, WorkspaceScanSummary } from './types';

/** Expected JSON shape from Signal extension API (to be implemented on the backend). */
interface ExtensionScanResponse {
  findings?: Finding[];
  error?: string;
}

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/$/, '');
}

function buildUrl(base: string, path: string): string {
  const b = normalizeBaseUrl(base);
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function authHeaders(token: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function parseFindings(raw: unknown): Finding[] {
  if (!raw || typeof raw !== 'object') return [];
  const f = (raw as ExtensionScanResponse).findings;
  if (!Array.isArray(f)) return [];
  const rows = f as unknown[];
  return rows.map((item, i) => {
    const o =
      item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const severity = o.severity;
    const sev =
      severity === 'critical' ||
      severity === 'high' ||
      severity === 'medium' ||
      severity === 'low' ||
      severity === 'info'
        ? severity
        : 'medium';
    return {
      id: typeof o.id === 'string' && o.id ? o.id : `finding-${i}-${String(o.category ?? 'x').slice(0, 8)}`,
      severity: sev,
      category: typeof o.category === 'string' ? o.category : 'Finding',
      description: typeof o.description === 'string' ? o.description : '',
      filePath: typeof o.filePath === 'string' ? o.filePath : undefined,
      lineNumber: typeof o.lineNumber === 'number' ? o.lineNumber : undefined,
      snippet: typeof o.snippet === 'string' ? o.snippet : undefined,
      weightedScore: typeof o.weightedScore === 'number' ? o.weightedScore : undefined,
    };
  });
}

function parseWorkspaceSummary(
  data: unknown,
  indexedFileCount: number,
  findings: Finding[],
): WorkspaceScanSummary {
  if (!data || typeof data !== 'object') {
    return deriveWorkspaceSummaryFromFindings(findings, indexedFileCount);
  }
  const summary = (data as { summary?: unknown }).summary;
  if (!summary || typeof summary !== 'object') {
    return deriveWorkspaceSummaryFromFindings(findings, indexedFileCount);
  }
  const s = summary as Record<string, unknown>;
  const sc = s.severityCounts;
  if (typeof s.securityScore !== 'number' || !sc || typeof sc !== 'object') {
    return deriveWorkspaceSummaryFromFindings(findings, indexedFileCount);
  }
  const c = sc as Record<string, unknown>;
  return {
    scannedFilesCount:
      typeof s.scannedFilesCount === 'number' ? s.scannedFilesCount : indexedFileCount,
    totalFindings: typeof s.totalFindings === 'number' ? s.totalFindings : findings.length,
    severityCounts: {
      critical: Number(c.critical) || 0,
      high: Number(c.high) || 0,
      medium: Number(c.medium) || 0,
      low: Number(c.low) || 0,
    },
    securityScore: s.securityScore,
    totalWeightedScore: typeof s.totalWeightedScore === 'number' ? s.totalWeightedScore : undefined,
  };
}

/**
 * POST workspace file bundle to Signal. When `apiBaseUrl` is empty, returns an indexed-only result.
 */
export async function scanWorkspaceWithApi(
  apiBaseUrl: string,
  apiToken: string,
  workspacePath: string,
  files: IndexedFile[],
): Promise<WorkspaceScanResult> {
  const indexedFileCount = files.length;
  if (!apiBaseUrl) {
    return {
      findings: [],
      indexedFileCount,
      message: 'Set signal.apiBaseUrl to POST scans to your API.',
      summary: deriveWorkspaceSummaryFromFindings([], indexedFileCount),
    };
  }

  try {
    const res = await fetch(buildUrl(apiBaseUrl, workspacePath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiToken),
      },
      body: JSON.stringify({
        source: 'vscode-extension',
        files: files.map((f) => ({ path: f.relativePath, content: f.content })),
      }),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid JSON from API' };
    }

    if (!res.ok) {
      const err =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error?: string }).error)
          : `HTTP ${res.status}`;
      return {
        findings: [],
        indexedFileCount,
        message: err,
        summary: deriveWorkspaceSummaryFromFindings([], indexedFileCount),
      };
    }

    const findings = parseFindings(data);
    return {
      findings,
      indexedFileCount,
      summary: parseWorkspaceSummary(data, indexedFileCount, findings),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      findings: [],
      indexedFileCount,
      message: msg,
      summary: deriveWorkspaceSummaryFromFindings([], indexedFileCount),
    };
  }
}

export async function scanSnippetWithApi(
  apiBaseUrl: string,
  apiToken: string,
  snippetPath: string,
  payload: SnippetScanPayload,
): Promise<{ findings: Finding[]; message?: string }> {
  if (!apiBaseUrl) {
    return { findings: [], message: 'Set signal.apiBaseUrl to enable selection scans.' };
  }

  try {
    const res = await fetch(buildUrl(apiBaseUrl, snippetPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiToken),
      },
      body: JSON.stringify({
        source: 'vscode-extension',
        ...payload,
      }),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid JSON from API' };
    }

    if (!res.ok) {
      const err =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error?: string }).error)
          : `HTTP ${res.status}`;
      return { findings: [], message: err };
    }

    return { findings: parseFindings(data) };
  } catch (e) {
    return { findings: [], message: e instanceof Error ? e.message : String(e) };
  }
}

export async function explainFindingWithApi(
  apiBaseUrl: string,
  apiToken: string,
  explainPath: string,
  finding: Finding,
): Promise<{ explanation: string; error?: string }> {
  if (!apiBaseUrl) {
    return { explanation: '', error: 'Set signal.apiBaseUrl to enable Explain finding.' };
  }
  try {
    const res = await fetch(buildUrl(apiBaseUrl, explainPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiToken),
      },
      body: JSON.stringify({
        source: 'vscode-extension',
        finding: {
          severity: finding.severity,
          category: finding.category,
          description: finding.description,
          filePath: finding.filePath,
          lineNumber: finding.lineNumber,
          snippet: finding.snippet,
        },
      }),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid response' };
    }
    if (!res.ok) {
      const err =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error?: string }).error)
          : `HTTP ${res.status}`;
      return { explanation: '', error: err };
    }
    const explanation =
      typeof data === 'object' && data && typeof (data as { explanation?: string }).explanation === 'string'
        ? (data as { explanation: string }).explanation
        : '';
    return { explanation };
  } catch (e) {
    return { explanation: '', error: e instanceof Error ? e.message : String(e) };
  }
}
