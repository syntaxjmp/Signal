/** Aligns with Signal `project_findings.severity` (ENUM). */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  filePath?: string;
  lineNumber?: number;
  snippet?: string;
  /** Risk weight from API (matches web findings report). */
  weightedScore?: number;
}

/** Workspace scan aggregates (matches backend `buildExtensionWorkspaceSummary`). */
export interface WorkspaceScanSummary {
  scannedFilesCount: number;
  totalFindings: number;
  severityCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  securityScore: number;
  totalWeightedScore?: number;
}

export interface IndexedFile {
  /** Workspace-relative POSIX path */
  relativePath: string;
  content: string;
}

export interface WorkspaceScanResult {
  findings: Finding[];
  indexedFileCount: number;
  /** From API workspace-scan; derived locally if missing. */
  summary?: WorkspaceScanSummary;
  /** Set when the API was not called or returned an error */
  message?: string;
}

export interface SnippetScanPayload {
  code: string;
  languageId: string;
  filePath?: string;
}
