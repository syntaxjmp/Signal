import * as vscode from 'vscode';

const S = 'signal';

export function getSignalConfig() {
  const c = vscode.workspace.getConfiguration(S);
  return {
    apiBaseUrl: (c.get<string>('apiBaseUrl') ?? '').replace(/\/$/, ''),
    apiToken: c.get<string>('apiToken') ?? '',
    workspaceScanPath: c.get<string>('workspaceScanPath') ?? '/api/extension/workspace-scan',
    snippetScanPath: c.get<string>('snippetScanPath') ?? '/api/extension/snippet-scan',
    explainFindingPath: c.get<string>('explainFindingPath') ?? '/api/extension/explain-finding',
    maxFiles: c.get<number>('maxFiles') ?? 100,
    maxFileBytes: c.get<number>('maxFileBytes') ?? 1024 * 1024,
    scanOnStartup: c.get<boolean>('scanOnStartup') ?? true,
    /** Workspace-relative path for LLM memory / rules (Markdown). */
    skillsFile: (c.get<string>('skillsFile') ?? 'skills.md').replace(/^[\\/]+/, ''),
    /** After each workspace scan, rewrite the auto-generated block in `skillsFile` from findings. */
    autoUpdateSkillsOnScan: c.get<boolean>('autoUpdateSkillsOnScan') ?? true,
  };
}

/** Severity sort: most severe first */
export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
