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
}

export interface IndexedFile {
  /** Workspace-relative POSIX path */
  relativePath: string;
  content: string;
}

export interface WorkspaceScanResult {
  findings: Finding[];
  indexedFileCount: number;
  /** Set when the API was not called or returned an error */
  message?: string;
}

export interface SnippetScanPayload {
  code: string;
  languageId: string;
  filePath?: string;
}
