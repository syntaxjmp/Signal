import axios from 'axios';
import AdmZip from 'adm-zip';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import pLimit from 'p-limit';
import { vulnAgentPrompt } from '../ai/vulnAgentPrompt.js';
import { extractCodeElementsFromFile } from './codeElementModeling.js';

const MAX_FILE_BYTES = 1024 * 1024;
const SNIPPET_WINDOW = 60;
const SNIPPET_STEP = 40; // 20-line overlap between windows
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY) || 10;
const SCAN_MAX_FILES = Number(process.env.SCAN_MAX_FILES) || 100;
const MAX_RETRIES = 3;

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
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
]);

// --- File priority patterns (higher = scanned first) ---

const HIGH_PRIORITY_PATTERNS = [
  /auth/i, /login/i, /password/i, /session/i, /middleware/i,
  /route/i, /controller/i, /api\//i, /db/i, /database/i,
  /query/i, /sql/i, /admin/i, /upload/i, /config/i, /\.env/i,
];

const MEDIUM_PRIORITY_PATTERNS = [
  /service/i, /model/i, /crypto/i, /hash/i, /token/i,
  /jwt/i, /cors/i, /helmet/i, /util/i, /helper/i,
];

const SKIP_PATTERNS = [
  /\.test\./i, /\.spec\./i, /__tests__\//i, /\.d\.ts$/i,
  /\.stories\./i, /\.snap$/i, /fixture/i, /mock/i,
];

function filePriority(relPath) {
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(relPath)) return -1; // skip entirely
  }
  for (const pat of HIGH_PRIORITY_PATTERNS) {
    if (pat.test(relPath)) return 2;
  }
  for (const pat of MEDIUM_PRIORITY_PATTERNS) {
    if (pat.test(relPath)) return 1;
  }
  return 0;
}

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

function prioritizeAndFilter(files) {
  const scored = files
    .map((f) => ({ ...f, priority: filePriority(f.rel) }))
    .filter((f) => f.priority >= 0) // drop files matching SKIP_PATTERNS
    .sort((a, b) => b.priority - a.priority); // high-priority first

  return scored.slice(0, SCAN_MAX_FILES);
}

function makeSnippets(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const snippets = [];
  for (let i = 0; i < lines.length; i += SNIPPET_STEP) {
    const chunk = lines.slice(i, i + SNIPPET_WINDOW);
    if (chunk.join('').trim() === '') continue;
    snippets.push({
      startLine: i + 1,
      text: chunk.map((line, idx) => `${i + idx + 1}: ${line}`).join('\n'),
    });
    // If this chunk already reaches end-of-file, stop
    if (i + SNIPPET_WINDOW >= lines.length) break;
  }
  return snippets;
}

function extractImports(content) {
  const lines = content.split(/\r?\n/).slice(0, 15);
  const imports = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^import\s/.test(trimmed) || /^const\s.*=\s*require\(/.test(trimmed) || /^from\s/.test(trimmed)) {
      imports.push(trimmed);
    }
  }
  return imports.length > 0 ? imports.join('\n') : null;
}

async function analyzeSnippetWithRetry(client, model, snippetPayload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: vulnAgentPrompt },
          { role: 'user', content: snippetPayload },
        ],
      });
      return safeArrayJson(response.choices?.[0]?.message?.content || '[]');
    } catch (err) {
      lastError = err;
      const status = err?.status || err?.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`[scan] API retry ${attempt}/${MAX_RETRIES} after ${delay}ms (status ${status})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err; // non-retryable error
    }
  }
  throw lastError;
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

  const scanStart = Date.now();
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

    const allFiles = await collectFiles(extractedRoot);
    const files = prioritizeAndFilter(allFiles);
    console.info(`[scan] ${allFiles.length} files found, ${files.length} after priority filter`);

    const client = new OpenAI({ apiKey: openAiApiKey });
    const limit = pLimit(SCAN_CONCURRENCY);
    const codeElements = [];

    // Build all tasks upfront
    const tasks = [];
    for (const f of files) {
      const content = await readFile(f.full, 'utf8').catch(() => '');
      if (!content.trim()) continue;
      codeElements.push(...extractCodeElementsFromFile({ filePath: f.rel, content }));
      const snippets = makeSnippets(content);
      const fileImports = extractImports(content);

      for (const snippet of snippets) {
        const promptParts = [
          `Repository: ${parsed.owner}/${parsed.repo}`,
          `File: ${f.rel}`,
        ];
        if (fileImports) {
          promptParts.push(`File imports:\n${fileImports}`);
        }
        promptParts.push(
          `Snippet (lines ${snippet.startLine}–${snippet.startLine + SNIPPET_WINDOW - 1}):`,
          snippet.text,
        );
        tasks.push({
          file: f,
          snippet,
          userPrompt: promptParts.join('\n\n'),
        });
      }
    }

    console.info(`[scan] ${tasks.length} snippet tasks queued, concurrency=${SCAN_CONCURRENCY}`);

    // Execute all tasks concurrently with p-limit
    const results = await Promise.all(
      tasks.map((task) =>
        limit(async () => {
          const rawFindings = await analyzeSnippetWithRetry(client, openAiModel, task.userPrompt);
          return { task, rawFindings };
        }),
      ),
    );

    // Collect findings
    const findings = [];
    for (const { task, rawFindings } of results) {
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
          filePath: task.file.rel,
          snippet: task.snippet.text,
        });
      }
    }

    // Deduplicate
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

    // Severity pressure — critical and high findings are weighted much more heavily
    const severityPressure =
      severityCounts.critical * 4.0 +
      severityCounts.high * 2.0 +
      severityCounts.medium * 0.5 +
      severityCounts.low * 0.1;

    // Risk index combines raw weighted scores with severity pressure
    const riskIndex = rawTotalWeightedScore + severityPressure * 8;

    // Security score 0-50: 0 = perfectly secure, 50 = very insecure
    // Uses saturating logarithmic growth — even a single critical finding pushes the score up fast
    const securityScore = Math.max(0, Math.min(50, Math.round(50 * (1 - Math.exp(-riskIndex / 80)))));
    const scorePenalty = securityScore;

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    console.info(`[scan] completed in ${elapsed}s — ${uniqueFindings.length} findings from ${files.length} files`);

    return {
      scannedFilesCount: files.length,
      findings: uniqueFindings,
      codeElements: codeElements.slice(0, 3000),
      summary: {
        severityCounts,
        totalFindings: uniqueFindings.length,
        totalWeightedScore: rawTotalWeightedScore,
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

function dedupeVulnerabilityFindings(findings) {
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
  return [...dedupe.values()];
}

function toExtensionFinding(f) {
  return {
    id: crypto.randomUUID(),
    severity: f.severity,
    category: f.category,
    description: f.description,
    lineNumber: f.lineNumber ?? undefined,
    filePath: f.filePath,
    snippet: f.snippet ? String(f.snippet).slice(0, 800) : undefined,
    weightedScore: typeof f.weightedScore === 'number' ? f.weightedScore : severityToWeight(f.severity),
  };
}

/** Same security score model as GitHub project scans (0–50, higher = more risk). */
function buildExtensionWorkspaceSummary(uniqueFindings, scannedFilesCount) {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalWeight = 0;
  for (const f of uniqueFindings) {
    const sev = f.severity;
    if (Object.prototype.hasOwnProperty.call(severityCounts, sev)) {
      severityCounts[sev] += 1;
    } else {
      severityCounts.low += 1;
    }
    totalWeight += f.weightedScore ?? severityToWeight(sev);
  }
  const rawTotalWeightedScore = totalWeight;
  const severityPressure =
    severityCounts.critical * 4.0 +
    severityCounts.high * 2.0 +
    severityCounts.medium * 0.5 +
    severityCounts.low * 0.1;
  const riskIndex = rawTotalWeightedScore + severityPressure * 8;
  const securityScore = Math.max(0, Math.min(50, Math.round(50 * (1 - Math.exp(-riskIndex / 80)))));
  return {
    scannedFilesCount,
    totalFindings: uniqueFindings.length,
    severityCounts,
    securityScore,
    totalWeightedScore: rawTotalWeightedScore,
  };
}

/** VS Code extension — scan a user-selected snippet. */
export async function extensionScanSnippet({
  code,
  filePath = 'selection',
  languageId = 'text',
  openAiApiKey,
  openAiModel = 'gpt-4o-mini',
}) {
  if (!openAiApiKey?.trim()) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const client = new OpenAI({ apiKey: openAiApiKey });
  const snippets = makeSnippets(code);
  if (snippets.length === 0) {
    return { findings: [] };
  }
  const fileImports = extractImports(code);
  const findings = [];
  for (const snippet of snippets) {
    const promptParts = [
      'Source: VS Code extension (selection scan)',
      `File: ${filePath}`,
      `Language: ${languageId}`,
    ];
    if (fileImports) {
      promptParts.push(`File imports:\n${fileImports}`);
    }
    promptParts.push(
      `Snippet (lines ${snippet.startLine}–${snippet.startLine + SNIPPET_WINDOW - 1}):`,
      snippet.text,
    );
    const rawFindings = await analyzeSnippetWithRetry(client, openAiModel, promptParts.join('\n\n'));
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
        filePath,
        snippet: snippet.text,
      });
    }
  }
  const unique = dedupeVulnerabilityFindings(findings);
  return { findings: unique.map(toExtensionFinding) };
}

/**
 * VS Code extension — scan workspace files as `{ path, content }[]`.
 * @param {{ path: string, content: string }[]} files
 */
export async function extensionScanWorkspaceFiles({
  files,
  openAiApiKey,
  openAiModel = 'gpt-4o-mini',
}) {
  if (!openAiApiKey?.trim()) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!Array.isArray(files)) {
    return {
      findings: [],
      summary: buildExtensionWorkspaceSummary([], 0),
    };
  }

  const scannedFilesCount = files.filter((f) => {
    const rel = typeof f.path === 'string' ? f.path.replace(/\\/g, '/') : '';
    const content = typeof f.content === 'string' ? f.content : '';
    return Boolean(rel && content.trim());
  }).length;

  if (files.length === 0) {
    return {
      findings: [],
      summary: buildExtensionWorkspaceSummary([], 0),
    };
  }

  const client = new OpenAI({ apiKey: openAiApiKey });
  const limit = pLimit(SCAN_CONCURRENCY);
  const tasks = [];

  for (const f of files) {
    const rel = typeof f.path === 'string' ? f.path.replace(/\\/g, '/') : '';
    const content = typeof f.content === 'string' ? f.content : '';
    if (!rel || !content.trim()) continue;

    const snippets = makeSnippets(content);
    const fileImports = extractImports(content);
    for (const snippet of snippets) {
      const promptParts = [
        'Source: VS Code extension (workspace scan)',
        `File: ${rel}`,
      ];
      if (fileImports) {
        promptParts.push(`File imports:\n${fileImports}`);
      }
      promptParts.push(
        `Snippet (lines ${snippet.startLine}–${snippet.startLine + SNIPPET_WINDOW - 1}):`,
        snippet.text,
      );
      tasks.push({ rel, snippet, userPrompt: promptParts.join('\n\n') });
    }
  }

  const results = await Promise.all(
    tasks.map((task) =>
      limit(async () => {
        const rawFindings = await analyzeSnippetWithRetry(client, openAiModel, task.userPrompt);
        return { task, rawFindings };
      }),
    ),
  );

  const findings = [];
  for (const { task, rawFindings } of results) {
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
        filePath: task.rel,
        snippet: task.snippet.text,
      });
    }
  }

  const unique = dedupeVulnerabilityFindings(findings);
  const summary = buildExtensionWorkspaceSummary(unique, scannedFilesCount);
  return {
    findings: unique.map(toExtensionFinding),
    summary,
  };
}

export function validateGitHubUrl(githubUrl) {
  return parseGitHubUrl(githubUrl) !== null;
}
