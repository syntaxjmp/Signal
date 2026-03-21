import * as path from 'node:path';
import * as vscode from 'vscode';
import { scanSnippetWithApi, scanWorkspaceWithApi } from './apiClient';
import { getSignalConfig } from './config';
import { FindingsTreeProvider, sortFindings } from './findingsTreeProvider';
import type { Finding, FindingSeverity, WorkspaceScanResult } from './types';
import { collectWorkspaceFiles } from './workspaceScanner';
import { explainFindingWithApi } from './apiClient';
import { openExplainFindingPanel } from './explainFindingPanel';
import { openWorkspaceReportPanel } from './workspaceReportPanel';

let lastWorkspaceScan: { folderName: string; result: WorkspaceScanResult } | null = null;

function getWorkspaceFolderDisplayName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return 'Workspace';
  return path.basename(folder.uri.fsPath);
}

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function getSeverityBreakdown(findings: Finding[]): string {
  if (findings.length === 0) return '';
  const counts = new Map<FindingSeverity, number>();
  for (const f of findings) {
    counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  }
  return SEVERITY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${s}`)
    .join(', ');
}

/** Worst severity present (critical > high > …). */
function getHighestSeverityLevel(findings: Finding[]): FindingSeverity | null {
  for (const sev of SEVERITY_ORDER) {
    if (findings.some((f) => f.severity === sev)) return sev;
  }
  return null;
}

/** Unique finding titles (API `category`), first few, truncated for toast length. */
function getFindingTitlesPreview(findings: Finding[], maxTitles = 4, maxChars = 160): string {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const f of findings) {
    const t = (f.category || 'Finding').trim() || 'Finding';
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(t);
    if (titles.length >= maxTitles) break;
  }
  let joined = titles.join('; ');
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars - 1)}…`;
  }
  return joined;
}

function formatSignalFoundMessage(findings: Finding[], context: 'selection' | 'workspace'): string {
  if (findings.length === 0) {
    return context === 'selection'
      ? 'Signal found no security findings in this selection.'
      : 'Signal found no security findings in the workspace.';
  }
  const breakdown = getSeverityBreakdown(findings);
  const level = getHighestSeverityLevel(findings);
  const titles = getFindingTitlesPreview(findings);
  const where = context === 'selection' ? 'this selection' : 'your workspace';
  return [
    `Signal found ${findings.length} finding(s) in ${where}.`,
    `Severity: ${breakdown}.`,
    level ? `Highest level: ${level}.` : '',
    titles ? `What we found: ${titles}.` : '',
    'Open Signal Findings for full details.',
  ]
    .filter(Boolean)
    .join(' ');
}

let findingsProvider: FindingsTreeProvider;

async function runExplainFinding(finding: Finding): Promise<void> {
  const cfg = getSignalConfig();
  const { explanation, error } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Signal: explaining finding…' },
    async () =>
      explainFindingWithApi(cfg.apiBaseUrl, cfg.apiToken, cfg.explainFindingPath, finding),
  );
  openExplainFindingPanel(finding, explanation || '', error);
}

export function activate(context: vscode.ExtensionContext): void {
  findingsProvider = new FindingsTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('signal.findings', findingsProvider));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'signal.scanWorkspace';
  context.subscriptions.push(status);

  const runWorkspaceScan = async (): Promise<void> => {
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage('Signal: open a folder to scan the workspace.');
      return;
    }
    status.text = '$(loading~spin) Signal';
    status.tooltip = 'Signal workspace scan';
    status.show();

    const cfg = getSignalConfig();
    const files = await collectWorkspaceFiles({
      maxFiles: cfg.maxFiles,
      maxFileBytes: cfg.maxFileBytes,
    });

    const raw = await scanWorkspaceWithApi(
      cfg.apiBaseUrl,
      cfg.apiToken,
      cfg.workspaceScanPath,
      files,
    );
    const result: WorkspaceScanResult = {
      ...raw,
      findings: sortFindings(raw.findings),
    };
    findingsProvider.refresh(result);

    const folderName = getWorkspaceFolderDisplayName();
    lastWorkspaceScan = { folderName, result };
    openWorkspaceReportPanel(folderName, result, { onExplainFinding: runExplainFinding });

    if (result.findings.length > 0) {
      vscode.window.showInformationMessage(formatSignalFoundMessage(result.findings, 'workspace'));
    }

    status.text = `$(shield) Signal (${result.findings.length})`;
    const severityPart = getSeverityBreakdown(result.findings);
    status.tooltip = severityPart
      ? `${result.indexedFileCount} files indexed · ${result.findings.length} findings (${severityPart})`
      : `${result.indexedFileCount} files indexed · ${result.findings.length} findings`;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('signal.scanWorkspace', runWorkspaceScan),

    vscode.commands.registerCommand('signal.scanSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Signal: no active editor.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      if (!text.trim()) {
        vscode.window.showWarningMessage('Signal: select code to scan.');
        return;
      }
      const cfg = getSignalConfig();
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const { findings, message } = await scanSnippetWithApi(cfg.apiBaseUrl, cfg.apiToken, cfg.snippetScanPath, {
        code: text,
        languageId: editor.document.languageId,
        filePath: rel,
      });
      const merged: WorkspaceScanResult = {
        findings: sortFindings(findings),
        indexedFileCount: 1,
        message: message ?? (findings.length ? `Selection scan: ${rel}` : undefined),
      };
      findingsProvider.refresh(merged);
      if (message && findings.length === 0) {
        vscode.window.showWarningMessage(`Signal: ${message}`);
      } else {
        vscode.window.showInformationMessage(formatSignalFoundMessage(findings, 'selection'));
      }
    }),

    vscode.commands.registerCommand('signal.openFinding', async (finding: Finding) => {
      if (!finding.filePath || !vscode.workspace.workspaceFolders?.length) {
        vscode.window.showInformationMessage('Signal: no file path on this finding.');
        return;
      }
      const folder = vscode.workspace.workspaceFolders[0].uri;
      const segments = finding.filePath.split(/[/\\]/);
      const fileUri = vscode.Uri.joinPath(folder, ...segments);
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc);
        const line = Math.max(0, (finding.lineNumber ?? 1) - 1);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch {
        vscode.window.showErrorMessage(`Signal: could not open ${finding.filePath}`);
      }
    }),

    vscode.commands.registerCommand('signal.resolveFinding', async (treeItem: vscode.TreeItem) => {
      const id = treeItem.id;
      if (!id) return;
      const f = findingsProvider.getFinding(id);
      if (!f) return;
      vscode.window.showInformationMessage(
        `Resolve (placeholder): ${f.category} — wire to POST /projects/:id/findings/:findingId/resolve`,
      );
    }),

    vscode.commands.registerCommand('signal.openWorkspaceReport', () => {
      if (!lastWorkspaceScan) {
        vscode.window.showWarningMessage('Signal: run “Scan workspace” first to generate a report.');
        return;
      }
      openWorkspaceReportPanel(lastWorkspaceScan.folderName, lastWorkspaceScan.result, {
        onExplainFinding: runExplainFinding,
      });
    }),

    vscode.commands.registerCommand('signal.explainFinding', async (treeItem?: vscode.TreeItem) => {
      let finding: Finding | undefined;
      if (treeItem?.id) {
        finding = findingsProvider.getFinding(treeItem.id);
      }
      if (!finding) {
        const findings = findingsProvider.getFindings();
        if (findings.length === 0) {
          vscode.window.showWarningMessage(
            'Signal: no findings to explain. Run a scan first, then right-click a finding and choose "Explain finding".',
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(
          findings.map((f) => ({
            label: `${f.severity}: ${f.category}`,
            description: f.filePath ? `${f.filePath}${f.lineNumber != null ? `:${f.lineNumber}` : ''}` : undefined,
            finding: f,
          })),
          { placeHolder: 'Choose a finding to explain', matchOnDescription: true },
        );
        finding = pick?.finding;
      }
      if (finding) {
        await runExplainFinding(finding);
      }
    }),
  );

  const cfg = getSignalConfig();
  if (cfg.scanOnStartup && vscode.workspace.workspaceFolders?.length) {
    void runWorkspaceScan();
  } else {
    status.text = '$(shield) Signal';
    status.tooltip = 'Click to scan workspace';
    status.show();
  }
}

export function deactivate(): void {}
