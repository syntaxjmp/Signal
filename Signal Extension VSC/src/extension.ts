import * as vscode from 'vscode';
import { scanSnippetWithApi, scanWorkspaceWithApi } from './apiClient';
import { getSignalConfig } from './config';
import { FindingsTreeProvider, sortFindings } from './findingsTreeProvider';
import type { Finding, WorkspaceScanResult } from './types';
import { collectWorkspaceFiles } from './workspaceScanner';

let findingsProvider: FindingsTreeProvider;

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

    status.text = `$(shield) Signal (${result.findings.length})`;
    status.tooltip = `${result.indexedFileCount} files indexed · ${result.findings.length} findings`;
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
        vscode.window.showInformationMessage(`Signal: ${findings.length} finding(s) in selection.`);
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
