import * as vscode from 'vscode';
import { deriveWorkspaceSummaryFromFindings } from './scanSummary';
import type { Finding, WorkspaceScanResult } from './types';

function getNonce(): string {
  let t = '';
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}

function fileBreakdown(findings: Finding[]): { file: string; path: string; count: number }[] {
  const m = new Map<string, { path: string; count: number }>();
  for (const f of findings) {
    const p = f.filePath || 'unknown';
    const base = p.split(/[/\\]/).pop() || p;
    const cur = m.get(p) ?? { path: p, count: 0 };
    cur.count += 1;
    m.set(p, cur);
  }
  return [...m.entries()]
    .map(([path, v]) => ({ file: path.split(/[/\\]/).pop() || path, path, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

export interface WorkspaceReportOptions {
  onExplainFinding?: (finding: Finding) => void;
}

export function openWorkspaceReportPanel(
  workspaceFolderName: string,
  result: WorkspaceScanResult,
  options?: WorkspaceReportOptions,
): void {
  const { onExplainFinding } = options ?? {};
  const summary =
    result.summary ?? deriveWorkspaceSummaryFromFindings(result.findings, result.indexedFileCount);
  const nonce = getNonce();
  const panel = vscode.window.createWebviewPanel(
    'signal.workspaceReport',
    `Signal — ${workspaceFolderName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );

  const payload = {
    workspaceName: workspaceFolderName,
    message: result.message ?? null,
    securityScore: summary.securityScore,
    severityCounts: summary.severityCounts,
    totalFindings: summary.totalFindings,
    scannedFilesCount: summary.scannedFilesCount,
    findings: result.findings,
    fileRows: fileBreakdown(result.findings),
  };

  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg0: #130704;
      --bg1: #1a0703;
      --text: #f8f0ed;
      --muted: rgba(255, 220, 210, 0.82);
      --accent: #ff5a34;
      --card: rgba(0,0,0,0.24);
      --border: rgba(255, 90, 52, 0.22);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 13px;
      color: var(--text);
      background: radial-gradient(circle at 50% 0%, rgba(255, 90, 52, 0.14), transparent 46%),
        linear-gradient(180deg, var(--bg0) 0%, var(--bg1) 52%, #100402 100%);
      min-height: 100vh;
      padding: 1rem 1.25rem 2rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 800;
      font-size: 1.35rem;
      margin-bottom: 0.25rem;
    }
    .brand span.sig { color: var(--accent); }
    .brand span.sep { color: var(--accent); opacity: 0.9; font-weight: 900; }
    h1 {
      margin: 0.5rem 0 0;
      font-size: clamp(1.2rem, 3vw, 1.65rem);
      font-weight: 800;
    }
    .subtitle { color: var(--muted); margin: 0.4rem 0 1rem; line-height: 1.45; }
    .banner {
      padding: 0.65rem 0.85rem;
      border-radius: 10px;
      margin-bottom: 1rem;
      border: 1px solid rgba(255, 200, 100, 0.35);
      background: rgba(80, 50, 0, 0.35);
      color: #ffe8c8;
    }
    .topgrid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .card {
      padding: 0.85rem 1rem;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.25) inset;
    }
    .card__label {
      color: rgba(255, 190, 170, 0.95);
      font-size: 0.8rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .gauge {
      margin-top: 0.5rem;
      display: flex;
      align-items: baseline;
      gap: 0.25rem;
    }
    .gauge__val { font-size: 2rem; font-weight: 900; line-height: 1; }
    .gauge__den { opacity: 0.65; font-weight: 700; }
    .meta { margin-top: 0.35rem; color: var(--muted); font-size: 0.9rem; }
    .bars { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem; }
    .bar {
      padding: 0.35rem 0.5rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .bar--critical { background: rgba(220, 38, 38, 0.25); color: #fecaca; }
    .bar--high { background: rgba(234, 88, 12, 0.25); color: #fed7aa; }
    .bar--medium { background: rgba(202, 138, 4, 0.22); color: #fef08a; }
    .bar--low { background: rgba(34, 197, 94, 0.15); color: #bbf7d0; }
    .summary-text { margin-top: 0.35rem; color: var(--muted); line-height: 1.5; }
    .file-rows { margin-top: 0.65rem; }
    .file-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.5rem;
      font-size: 0.8rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .file-row span:last-child { font-weight: 800; color: var(--accent); }
    .table-wrap { overflow-x: auto; margin-top: 0.75rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th {
      text-align: left;
      padding: 0.5rem 0.4rem;
      border-bottom: 1px solid var(--border);
      color: rgba(255, 190, 170, 0.95);
      font-weight: 800;
    }
    td {
      padding: 0.5rem 0.4rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      vertical-align: top;
    }
    tr[data-open] { cursor: pointer; }
    tr[data-open]:hover { background: rgba(255,255,255,0.04); }
    .sev {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 6px;
      font-weight: 800;
      font-size: 0.72rem;
      text-transform: uppercase;
    }
    .sev--critical { background: rgba(220,38,38,0.35); color: #fecaca; }
    .sev--high { background: rgba(234,88,12,0.35); color: #fed7aa; }
    .sev--medium { background: rgba(202,138,4,0.3); color: #fef9c3; }
    .sev--low, .sev--info { background: rgba(100,116,139,0.35); color: #e2e8f0; }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.78rem; }
    .explain-cell { white-space: nowrap; }
    .explain-btn {
      padding: 0.25rem 0.5rem;
      font-size: 0.78rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 90, 52, 0.5);
      background: rgba(255, 90, 52, 0.12);
      color: #ffb8a8;
      cursor: pointer;
    }
    .explain-btn:hover { background: rgba(255, 90, 52, 0.22); }
    .empty { padding: 1.5rem; text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <div class="brand"><span class="sig">Signal</span><span class="sep">/</span><span>Workspace report</span></div>
  <h1 id="title"></h1>
  <p class="subtitle">Same style metrics as the web findings report — scoped to this VS Code workspace folder.</p>
  <div id="banner" class="banner" style="display:none"></div>
  <section class="topgrid">
    <div class="card">
      <div class="card__label">Security score</div>
      <div class="gauge" id="gauge"></div>
      <div class="meta" id="scoreMeta"></div>
    </div>
    <div class="card">
      <div class="card__label">Score breakdown</div>
      <div class="bars" id="bars"></div>
    </div>
    <div class="card">
      <div class="card__label">Summary</div>
      <div class="summary-text" id="genSummary"></div>
      <div class="file-rows" id="fileRows"></div>
    </div>
  </section>
  <div class="card">
    <div class="card__label">Vulnerabilities</div>
    <div class="table-wrap" id="tableHost"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const PAYLOAD = ${JSON.stringify(payload)};

    document.getElementById('title').textContent = 'Workspace: ' + PAYLOAD.workspaceName;

    if (PAYLOAD.message) {
      const b = document.getElementById('banner');
      b.style.display = 'block';
      b.textContent = PAYLOAD.message;
    }

    const sc = PAYLOAD.securityScore;
    const gaugeColor = (function (score) {
      const clamped = Math.max(0, Math.min(50, score));
      const hue = 150 * (1 - clamped / 50);
      return 'hsl(' + Math.round(hue) + ', 65%, 58%)';
    })(sc);

    const gaugeEl = document.getElementById('gauge');
    gaugeEl.innerHTML = '<span class="gauge__val" style="color:' + gaugeColor + '">' + sc + '</span><span class="gauge__den">/ 50</span>';

    const label = sc <= 10 ? 'Strong' : sc <= 25 ? 'Moderate' : 'At risk';
    document.getElementById('scoreMeta').textContent = label;

    const sev = PAYLOAD.severityCounts;
    const barHtml = [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low'],
    ].map(function (x) {
      return '<div class="bar bar--' + x[0] + '">' + x[1] + ': ' + (sev[x[0]] || 0) + '</div>';
    }).join('');
    document.getElementById('bars').innerHTML = barHtml;

    document.getElementById('genSummary').textContent =
      'Total findings: ' + PAYLOAD.totalFindings + ' across ' + PAYLOAD.scannedFilesCount + ' scanned files.';

    const fr = PAYLOAD.fileRows || [];
    const frHost = document.getElementById('fileRows');
    if (fr.length) {
      frHost.innerHTML = fr.map(function (r) {
        return '<div class="file-row"><span class="mono" title="' + String(r.path).replace(/"/g, '&quot;') + '">' +
          String(r.file).replace(/</g, '&lt;') + '</span><span>' + r.count + '</span></div>';
      }).join('');
    } else {
      frHost.innerHTML = '';
    }

    const findings = PAYLOAD.findings || [];
    const th = document.getElementById('tableHost');
    if (!findings.length) {
      th.innerHTML = '<div class="empty">No vulnerabilities in this scan. Your workspace looks clear.</div>';
    } else {
      var rows = findings.map(function (f, idx) {
        var fp = f.filePath || '—';
        var base = fp.split(/[/\\\\]/).pop() || fp;
        var line = f.lineNumber != null ? ':' + f.lineNumber : '';
        var ws = f.weightedScore != null ? String(f.weightedScore) : '—';
        var sevClass = 'sev--' + (f.severity === 'info' ? 'low' : f.severity);
        var explainBtn = '<button class="explain-btn" data-idx="' + idx + '" title="Get a friendly explanation for junior devs">Explain</button>';
        return '<tr data-open="1" data-file="' + encodeURIComponent(fp) + '" data-line="' + (f.lineNumber || 1) + '">' +
          '<td><span class="sev ' + sevClass + '">' + f.severity + '</span></td>' +
          '<td>' + String(f.category).replace(/</g, '&lt;') + '</td>' +
          '<td>' + String(f.description).replace(/</g, '&lt;') + '</td>' +
          '<td class="mono">' + String(base).replace(/</g, '&lt;') + line + '</td>' +
          '<td>' + ws + '</td>' +
          '<td class="explain-cell">' + explainBtn + '</td></tr>';
      }).join('');
      th.innerHTML = '<table><thead><tr><th>Severity</th><th>Category</th><th>Description</th><th>File</th><th>Score</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';

      th.querySelectorAll('tr[data-open]').forEach(function (row) {
        row.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t.nodeType !== 1) t = t.parentNode;
          if (t && typeof t.closest === 'function' && t.closest('.explain-btn')) return;
          var file = decodeURIComponent(row.getAttribute('data-file') || '');
          var line = parseInt(row.getAttribute('data-line') || '1', 10);
          vscode.postMessage({ type: 'openFinding', filePath: file, lineNumber: line });
        });
      });
      th.querySelectorAll('.explain-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
          var finding = PAYLOAD.findings[idx];
          if (finding) vscode.postMessage({ type: 'explainFinding', finding: finding });
        });
      });
    }
  </script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(
    (msg: { type?: string; filePath?: string; lineNumber?: number; finding?: Finding }) => {
      if (msg?.type === 'explainFinding' && msg.finding && onExplainFinding) {
        onExplainFinding(msg.finding);
        return;
      }
      if (msg?.type !== 'openFinding' || !msg.filePath || !vscode.workspace.workspaceFolders?.length)
        return;
      const folder = vscode.workspace.workspaceFolders[0].uri;
      const segments = msg.filePath.split(/[/\\]/);
      const fileUri = vscode.Uri.joinPath(folder, ...segments);
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const editor = await vscode.window.showTextDocument(doc);
          const line = Math.max(0, (msg.lineNumber ?? 1) - 1);
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch {
          vscode.window.showErrorMessage(`Signal: could not open ${msg.filePath}`);
        }
      })();
    },
  );
}
