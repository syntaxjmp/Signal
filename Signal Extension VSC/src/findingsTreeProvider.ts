import * as vscode from 'vscode';
import { SEVERITY_ORDER } from './config';
import type { Finding, FindingSeverity, WorkspaceScanResult } from './types';

export type TreeKind = 'summary' | 'severity' | 'finding';

export interface FindingTreeItemModel {
  kind: TreeKind;
  label: string;
  description?: string;
  severity?: FindingSeverity;
  finding?: Finding;
  collapsible?: vscode.TreeItemCollapsibleState;
}

export class FindingsTreeProvider implements vscode.TreeDataProvider<FindingTreeItemModel> {
  private _onDidChange = new vscode.EventEmitter<FindingTreeItemModel | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private lastResult: WorkspaceScanResult | null = null;
  private findingById = new Map<string, Finding>();

  refresh(result: WorkspaceScanResult): void {
    this.lastResult = result;
    this.findingById.clear();
    for (const f of result.findings) {
      this.findingById.set(f.id, f);
    }
    this._onDidChange.fire();
  }

  getFinding(id: string): Finding | undefined {
    return this.findingById.get(id);
  }

  getFindings(): Finding[] {
    return this.lastResult?.findings ?? [];
  }

  getTreeItem(element: FindingTreeItemModel): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsible ?? vscode.TreeItemCollapsibleState.None);

    if (element.kind === 'finding' && element.finding) {
      const f = element.finding;
      item.id = f.id;
      item.contextValue = 'finding';
      item.description = f.filePath ? `${f.filePath}:${f.lineNumber ?? '?'}` : undefined;
      item.tooltip = new vscode.MarkdownString();
      item.tooltip.appendMarkdown(`**${f.category}**\n\n${f.description}`);
      if (f.snippet) {
        item.tooltip.appendMarkdown(`\n\n\`\`\`\n${f.snippet.slice(0, 800)}${f.snippet.length > 800 ? '\n…' : ''}\n\`\`\``);
      }
      item.iconPath = severityIcon(f.severity);
      item.command = {
        command: 'signal.openFinding',
        title: 'Open',
        arguments: [f],
      };
    } else if (element.kind === 'severity') {
      item.iconPath = severityIcon(element.severity ?? 'info');
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    } else if (element.kind === 'summary') {
      item.iconPath = new vscode.ThemeIcon('info');
    }

    return item;
  }

  getChildren(element?: FindingTreeItemModel): FindingTreeItemModel[] {
    if (!this.lastResult) {
      return [
        {
          kind: 'summary',
          label: 'No scan yet — run “Signal: Scan workspace”',
        },
      ];
    }

    if (!element) {
      const { indexedFileCount, findings, message } = this.lastResult;
      const summaryLabel = message
        ? `Indexed ${indexedFileCount} files — ${message}`
        : `Indexed ${indexedFileCount} files — ${findings.length} finding(s)`;
      return [{ kind: 'summary', label: summaryLabel }, ...groupBySeverity(findings)];
    }

    if (element.kind === 'severity' && element.severity) {
      const list = this.lastResult.findings.filter((f) => f.severity === element.severity);
      return list.map((finding) => ({
        kind: 'finding',
        label: truncate(finding.category || 'Finding', 48),
        finding,
      }));
    }

    return [];
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function severityIcon(severity: FindingSeverity): vscode.ThemeIcon {
  switch (severity) {
    case 'critical':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'high':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case 'medium':
      return new vscode.ThemeIcon('circle-large-outline');
    case 'low':
      return new vscode.ThemeIcon('debug-breakpoint-log-unverified');
    default:
      return new vscode.ThemeIcon('info');
  }
}

function groupBySeverity(findings: Finding[]): FindingTreeItemModel[] {
  const order = ['critical', 'high', 'medium', 'low', 'info'] as const;
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  }
  return order
    .filter((sev) => (counts.get(sev) ?? 0) > 0)
    .map((sev) => ({
      kind: 'severity' as const,
      label: `${sev} (${counts.get(sev)})`,
      severity: sev,
      collapsible: vscode.TreeItemCollapsibleState.Expanded,
    }));
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const da = SEVERITY_ORDER[a.severity] ?? 99;
    const db = SEVERITY_ORDER[b.severity] ?? 99;
    if (da !== db) return da - db;
    return (a.filePath ?? '').localeCompare(b.filePath ?? '');
  });
}
