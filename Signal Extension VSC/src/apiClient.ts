import type { Finding, IndexedFile, SnippetScanPayload, WorkspaceScanResult } from './types';

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
    };
  });
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
      return { findings: [], indexedFileCount, message: err };
    }

    return {
      findings: parseFindings(data),
      indexedFileCount,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { findings: [], indexedFileCount, message: msg };
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
