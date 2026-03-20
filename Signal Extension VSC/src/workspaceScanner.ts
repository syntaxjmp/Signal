import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IndexedFile } from './types';

/** Mirrors `backend/src/services/projectScanner.js` SOURCE_EXTENSIONS */
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.go',
  '.rb',
  '.php',
  '.rs',
  '.cs',
  '.swift',
  '.kt',
  '.kts',
  '.sql',
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
]);

const SKIP_PATTERNS = [
  /\.test\./i,
  /\.spec\./i,
  /__tests__\//i,
  /\.d\.ts$/i,
  /\.stories\./i,
  /\.snap$/i,
  /fixture/i,
  /mock/i,
];

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/.next/**,**/build/**,**/out/**,**/.venv/**,**/target/**}';

function shouldSkipRelativePath(rel: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(rel.replace(/\\/g, '/')));
}

function filePriority(rel: string): number {
  const r = rel.replace(/\\/g, '/');
  if (shouldSkipRelativePath(r)) return -1;
  if (/auth|login|password|session|middleware|route|controller|api\/|db|database|query|sql|admin|upload|config|\.env/i.test(r)) {
    return 2;
  }
  if (/service|model|crypto|hash|token|jwt|cors|helmet|util|helper/i.test(r)) return 1;
  return 0;
}

function isSourceFile(fsPath: string): boolean {
  const ext = path.extname(fsPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Collects text files from the first workspace folder, capped by `maxFiles` / `maxFileBytes`.
 */
export async function collectWorkspaceFiles(options: {
  maxFiles: number;
  maxFileBytes: number;
}): Promise<IndexedFile[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return [];
  }

  const pattern = new vscode.RelativePattern(folder, '**/*');
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 10000);

  const candidates: { uri: vscode.Uri; rel: string; priority: number }[] = [];
  for (const uri of uris) {
    if (!isSourceFile(uri.fsPath)) continue;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    const priority = filePriority(rel);
    if (priority < 0) continue;
    candidates.push({ uri, rel, priority });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.rel.localeCompare(b.rel));

  const out: IndexedFile[] = [];
  for (const { uri, rel } of candidates) {
    if (out.length >= options.maxFiles) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > options.maxFileBytes) continue;
      const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      out.push({ relativePath: rel, content });
    } catch {
      // unreadable or binary treated as skip
    }
  }

  return out;
}
