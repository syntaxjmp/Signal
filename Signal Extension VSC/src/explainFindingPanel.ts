import * as vscode from 'vscode';
import type { Finding } from './types';

/** Minimal markdown-to-HTML for AI explanations (headers, bold, code, lists, paragraphs). */
function mdToHtml(md: string): string {
  let html = String(md)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) =>
    `<pre class="code-block"><code>${code.trim()}</code></pre>`,
  );
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/gs, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`.replace(/<p><\/p>/g, '').replace(/<p>(<h[123]>)/g, '$1').replace(/(<\/h[123]>)<\/p>/g, '$1');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function severityClass(sev: string): string {
  return ['critical', 'high', 'medium', 'low', 'info'].includes(sev) ? `sev--${sev}` : 'sev--medium';
}

/** Opens a friendly explanation panel. Call after fetching explanation (or pass errorMessage). */
export function openExplainFindingPanel(
  finding: Finding,
  explanation: string,
  errorMessage?: string,
): void {
  const title = finding.category || 'Security finding';
  const panel = vscode.window.createWebviewPanel(
    'signal.explainFinding',
    `Signal: Explain — ${title.slice(0, 40)}${title.length > 40 ? '…' : ''}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  const sevClass = severityClass(finding.severity);
  const fileLine =
    finding.filePath && finding.lineNumber != null
      ? `${finding.filePath}:${finding.lineNumber}`
      : finding.filePath || '—';

  const bodyContent = errorMessage
    ? `<div class="error-block"><p><strong>Couldn't get an explanation</strong></p><p>${escapeHtml(errorMessage)}</p><p>Make sure the Signal API is running and <code>signal.apiBaseUrl</code> is set.</p></div>`
    : `<div class="explanation-body">${mdToHtml(explanation)}</div>`;

  const csp = `default-src 'none'; style-src 'unsafe-inline'`;

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #1e1e1e;
      --surface: #252526;
      --text: #d4d4d4;
      --muted: #9d9d9d;
      --accent: #ff5a34;
      --critical: #f14c4c;
      --high: #e9732c;
      --medium: #cca700;
      --low: #4ec9b0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
      padding: 1.25rem 1.5rem 2rem;
    }
    .header {
      margin-bottom: 1.25rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      margin-right: 0.5rem;
    }
    .sev--critical { background: rgba(241,76,76,0.2); color: var(--critical); }
    .sev--high { background: rgba(233,115,44,0.2); color: var(--high); }
    .sev--medium { background: rgba(204,167,0,0.2); color: var(--medium); }
    .sev--low, .sev--info { background: rgba(78,201,176,0.15); color: var(--low); }
    .category { font-size: 1.15rem; font-weight: 700; margin: 0.35rem 0 0.2rem; }
    .meta { font-size: 0.85rem; color: var(--muted); font-family: var(--vscode-editor-font-family, monospace); }
    .teaser { color: var(--muted); margin-top: 0.35rem; font-size: 0.95rem; }
    .explanation-body { margin-top: 0.5rem; }
    .explanation-body h2 { font-size: 1.1rem; margin: 1.25rem 0 0.5rem; color: #fff; }
    .explanation-body h3 { font-size: 1rem; margin: 1rem 0 0.4rem; color: #e0e0e0; }
    .explanation-body p { margin: 0.5rem 0; }
    .explanation-body ul { margin: 0.5rem 0; padding-left: 1.5rem; }
    .explanation-body li { margin: 0.25rem 0; }
    .explanation-body code {
      background: rgba(255,255,255,0.08);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .explanation-body pre {
      background: rgba(0,0,0,0.35);
      padding: 0.75rem 1rem;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.88rem;
      margin: 0.75rem 0;
    }
    .explanation-body pre code { background: none; padding: 0; }
    .error-block {
      padding: 1rem;
      background: rgba(241,76,76,0.1);
      border: 1px solid rgba(241,76,76,0.3);
      border-radius: 8px;
      color: #f4a0a0;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="badge ${sevClass}">${escapeHtml(finding.severity)}</span>
    <div class="category">${escapeHtml(finding.category || 'Finding')}</div>
    <div class="meta">${escapeHtml(fileLine)}</div>
    ${finding.description ? `<div class="teaser">${escapeHtml(finding.description)}</div>` : ''}
  </div>
  ${bodyContent}
</body>
</html>`;
}
