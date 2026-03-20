import axios from 'axios';
import AdmZip from 'adm-zip';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { vulnAgentPrompt } from '../ai/vulnAgentPrompt.js';

const MAX_FILE_BYTES = 1024 * 1024;
const SNIPPET_LINES = 20;
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
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.sh',
  '.bash',
]);

function parseGitHubUrl(githubUrl) {
  let url;
  try {
    url = new URL(githubUrl);
  } catch {
    return null;
  }
  if (!/github\.com$/i.test(url.hostname)) return null;
  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/i, '') };
}

function shouldSkipDir(name) {
  return name === '.git' || name === 'node_modules';
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function severityToWeight(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 15;
  if (s === 'high') return 10;
  if (s === 'medium') return 6;
  return 2;
}

function normalizeSeverity(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  return 'low';
}

function safeArrayJson(text) {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function collectFiles(root, current = root, out = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      await collectFiles(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, full).replaceAll('\\', '/');
    if (!isSourceFile(rel)) continue;
    const st = await stat(full);
    if (st.size > MAX_FILE_BYTES) continue;
    out.push({ full, rel });
  }
  return out;
}

function makeSnippets(content) {
  const lines = content.split(/\r?\n/);
  const snippets = [];
  for (let i = 0; i < lines.length; i += SNIPPET_LINES) {
    const chunk = lines.slice(i, i + SNIPPET_LINES);
    if (chunk.join('').trim() === '') continue;
    snippets.push({
      startLine: i + 1,
      text: chunk.map((line, idx) => `${i + idx + 1}: ${line}`).join('\n'),
    });
  }
  return snippets;
}

async function analyzeSnippet(client, model, snippetPayload) {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: vulnAgentPrompt },
      { role: 'user', content: snippetPayload },
    ],
  });
  return safeArrayJson(response.choices?.[0]?.message?.content || '[]');
}

export async function scanGitHubProject({
  githubUrl,
  openAiApiKey,
  openAiModel = 'gpt-4o-mini',
  githubToken,
}) {
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed) {
    throw new Error('Invalid GitHub URL');
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'signal-scan-'));
  const zipPath = path.join(tempDir, 'repo.zip');
  let extractedRoot = tempDir;
  try {
    const zipUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/zipball`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'signal-scanner',
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

    const zipResp = await axios.get(zipUrl, {
      headers,
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });
    await writeFile(zipPath, Buffer.from(zipResp.data));

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir, true);
    const dirs = (await readdir(tempDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(tempDir, e.name));
    if (dirs.length > 0) extractedRoot = dirs[0];

    const files = await collectFiles(extractedRoot);
    const client = new OpenAI({ apiKey: openAiApiKey });
    const findings = [];

    for (const f of files) {
      const content = await readFile(f.full, 'utf8').catch(() => '');
      if (!content.trim()) continue;
      const snippets = makeSnippets(content);
      for (const snippet of snippets) {
        const userPrompt = [
          `Repository: ${parsed.owner}/${parsed.repo}`,
          `File: ${f.rel}`,
          `Snippet starts at line ${snippet.startLine}:`,
          snippet.text,
        ].join('\n\n');
        const rawFindings = await analyzeSnippet(client, openAiModel, userPrompt);
        for (const item of rawFindings) {
          const severity = normalizeSeverity(item.severity);
          const weightedScore = severityToWeight(severity);
          const lineNumber =
            Number.isFinite(Number(item.lineNumber)) && Number(item.lineNumber) > 0
              ? Number(item.lineNumber)
              : null;
          findings.push({
            severity,
            category: String(item.category || 'General'),
            description: String(item.description || 'Potential security issue detected'),
            lineNumber,
            weightedScore,
            filePath: f.rel,
            snippet: snippet.text,
          });
        }
      }
    }

    const dedupe = new Map();
    for (const f of findings) {
      const fingerprint = crypto
        .createHash('sha256')
        .update(
          [f.filePath, f.category.toLowerCase(), f.description.toLowerCase(), String(f.lineNumber || 0)].join('|'),
        )
        .digest('hex');
      if (!dedupe.has(fingerprint)) {
        dedupe.set(fingerprint, { ...f, fingerprint });
      }
    }
    const uniqueFindings = [...dedupe.values()];
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    let totalWeight = 0;
    for (const f of uniqueFindings) {
      severityCounts[f.severity] += 1;
      totalWeight += f.weightedScore;
    }
    const rawTotalWeightedScore = totalWeight;
    const totalWeightedScoreCapped = Math.min(30, rawTotalWeightedScore);

    const severityPressure =
      severityCounts.critical * 1.2 +
      severityCounts.high * 0.7 +
      severityCounts.medium * 0.35 +
      severityCounts.low * 0.1;
    const riskIndex = rawTotalWeightedScore + severityPressure * 6;
    const securityScore = Math.max(0, Math.min(30, Math.round(30 * Math.exp(-riskIndex / 180))));
    const scorePenalty = 30 - securityScore;

    return {
      scannedFilesCount: files.length,
      findings: uniqueFindings,
      summary: {
        severityCounts,
        totalFindings: uniqueFindings.length,
        totalWeightedScore: totalWeightedScoreCapped,
        rawTotalWeightedScore,
        riskIndex,
        scorePenalty,
        securityScore,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function validateGitHubUrl(githubUrl) {
  return parseGitHubUrl(githubUrl) !== null;
}

