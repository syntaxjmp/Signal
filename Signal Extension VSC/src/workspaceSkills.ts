import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'node:util';
import type { Finding } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const AUTO_START = '<!-- signal:auto-generated:start -->';
export const AUTO_END = '<!-- signal:auto-generated:end -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve `skills.md` (or configured relative path) under the first workspace folder. */
export function getSkillsUri(workspaceFolder: vscode.Uri, relativePath: string): vscode.Uri {
  const parts = relativePath.split(/[/\\]/).filter(Boolean);
  return vscode.Uri.joinPath(workspaceFolder, ...parts);
}

export async function readBundledTemplate(extensionUri: vscode.Uri): Promise<string> {
  const uri = vscode.Uri.joinPath(extensionUri, 'resources', 'skills.template.md');
  const bytes = await vscode.workspace.fs.readFile(uri);
  return dec.decode(bytes);
}

export async function readTextFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return dec.decode(bytes);
  } catch {
    return null;
  }
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, enc.encode(content));
}

/** Create workspace `skills` file from bundled template if it does not exist. */
export async function ensureSkillsFile(
  extensionUri: vscode.Uri,
  workspaceFolder: vscode.Uri,
  relativePath: string,
): Promise<vscode.Uri> {
  const target = getSkillsUri(workspaceFolder, relativePath);
  try {
    await vscode.workspace.fs.stat(target);
    return target;
  } catch {
    const template = await readBundledTemplate(extensionUri);
    await writeTextFile(target, template);
    return target;
  }
}

function formatFindingAsRule(f: Finding): string {
  const desc = (f.description || '').replace(/\s+/g, ' ').trim();
  const short = desc.length > 220 ? `${desc.slice(0, 217)}…` : desc;
  const loc =
    f.filePath != null && f.filePath.length > 0
      ? `\`${f.filePath}${f.lineNumber != null ? `:${f.lineNumber}` : ''}\``
      : 'workspace';
  const body = short || f.category || 'Finding';
  return `**${f.severity}** · ${body} — avoid repeating this pattern (see ${loc}).`;
}

/**
 * Markdown block for the auto-generated region: grouped by category, concise bullets for LLMs.
 */
export function buildAutoSectionFromFindings(findings: Finding[], scanIso: string): string {
  const lines: string[] = [AUTO_START, '', '## Scan-derived rules (Signal)', '', `_Last updated: ${scanIso}_`, ''];

  if (findings.length === 0) {
    lines.push(
      '_No findings in this run._ If you expected issues, check API connectivity and `signal.apiBaseUrl`.',
      '',
    );
  } else {
    lines.push(
      'Summaries from the latest workspace scan. Prefer fixes that remove the root cause, not only the symptom.',
      '',
    );
    const byCat = new Map<string, Finding[]>();
    for (const f of findings) {
      const k = (f.category || 'General').trim() || 'General';
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k)!.push(f);
    }
    const keys = [...byCat.keys()].sort((a, b) => a.localeCompare(b));
    for (const cat of keys) {
      const list = byCat.get(cat)!;
      lines.push(`### ${cat}`, '');
      for (const f of list) {
        lines.push(`- ${formatFindingAsRule(f)}`);
      }
      lines.push('');
    }
  }

  lines.push(AUTO_END);
  return lines.join('\n');
}

/** Replace the auto-generated block, or append it if markers are missing. */
export function mergeAutoSection(existing: string, autoBlock: string): string {
  const trimmed = existing.trimEnd();
  if (trimmed.includes(AUTO_START) && trimmed.includes(AUTO_END)) {
    const re = new RegExp(`${escapeRegExp(AUTO_START)}[\\s\\S]*?${escapeRegExp(AUTO_END)}`, 'm');
    return trimmed.replace(re, autoBlock.trim());
  }
  return `${trimmed}\n\n${autoBlock.trim()}\n`;
}

export async function updateSkillsFromFindings(
  extensionUri: vscode.Uri,
  workspaceFolder: vscode.Uri,
  skillsRelativePath: string,
  findings: Finding[],
): Promise<{ uri: vscode.Uri; created: boolean }> {
  const uri = getSkillsUri(workspaceFolder, skillsRelativePath);
  let created = false;
  let content = await readTextFile(uri);
  if (content == null) {
    content = await readBundledTemplate(extensionUri);
    created = true;
  }
  const iso = new Date().toISOString();
  const block = buildAutoSectionFromFindings(findings, iso);
  const next = mergeAutoSection(content, block);
  await writeTextFile(uri, next);
  return { uri, created };
}

export async function openSkillsDocument(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
