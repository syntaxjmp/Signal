import { createHash } from 'node:crypto';
import axios from 'axios';
import { env } from '../config/env.js';
import {
  buildFindingEmbeddingText,
  buildFixEmbeddingText,
  buildCodePatternEmbeddingText,
  embedTexts,
  EMBEDDING_DIMENSIONS,
} from './embeddingService.js';

/** Convert an arbitrary string key into a valid UUID v4-shaped string for Qdrant. */
function deterministicUuid(key) {
  const hex = createHash('md5').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isVectorEnabled() {
  return Boolean(env.qdrant.url && env.openAi.apiKey);
}

function qdrantHeaders() {
  return env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};
}

function qdrantBase() {
  return env.qdrant.url?.replace(/\/+$/, '') || '';
}

async function ensureCollection(name) {
  const base = qdrantBase();
  if (!base) return false;
  try {
    await axios.put(
      `${base}/collections/${encodeURIComponent(name)}`,
      {
        vectors: { size: EMBEDDING_DIMENSIONS, distance: 'Cosine' },
      },
      { headers: qdrantHeaders(), timeout: 10_000 },
    );
    return true;
  } catch (e) {
    // 409 = collection already exists — that's fine
    if (e?.response?.status === 409) return true;
    console.warn(`[vector] ensure collection "${name}" failed`, e?.message || e);
    return false;
  }
}

// ─── Finding Embeddings (existing) ───────────────────────────────────────────

export async function upsertFindingEmbeddings({
  findings,
  projectId,
  scanId,
  orgId = null,
  markDismissed = false,
  dismissReason = null,
}) {
  if (!isVectorEnabled()) return { enabled: false, upserted: 0 };
  if (!Array.isArray(findings) || findings.length === 0) return { enabled: true, upserted: 0 };
  const ready = await ensureCollection(env.qdrant.findingCollection);
  if (!ready) return { enabled: true, upserted: 0 };

  const items = findings.slice(0, 300);
  const texts = items.map(buildFindingEmbeddingText);
  const vectors = await embedTexts({ apiKey: env.openAi.apiKey, texts });
  const points = items.map((f, i) => ({
    id: f.id || deterministicUuid(`${scanId}:${f.fingerprint || i}`),
    vector: vectors[i],
    payload: {
      fingerprint: f.fingerprint || null,
      finding_id: f.id || null,
      project_id: projectId,
      org_id: orgId,
      scan_id: scanId,
      severity: f.severity,
      category: f.category,
      file_path: f.filePath || null,
      status: f.status || 'open',
      dismissed: Boolean(markDismissed),
      dismiss_reason: dismissReason || null,
    },
  }));

  const base = qdrantBase();
  await axios.put(
    `${base}/collections/${encodeURIComponent(env.qdrant.findingCollection)}/points`,
    { points },
    { headers: qdrantHeaders(), timeout: 30_000 },
  );
  return { enabled: true, upserted: points.length };
}

export async function searchSimilarDismissedFindings({
  projectId,
  finding,
  limit = 5,
  scoreThreshold = 0.92,
}) {
  if (!isVectorEnabled()) return [];
  if (!finding) return [];
  const ready = await ensureCollection(env.qdrant.findingCollection);
  if (!ready) return [];

  const [vector] = await embedTexts({
    apiKey: env.openAi.apiKey,
    texts: [buildFindingEmbeddingText(finding)],
  });
  if (!vector) return [];

  const base = qdrantBase();
  const response = await axios.post(
    `${base}/collections/${encodeURIComponent(env.qdrant.findingCollection)}/points/query`,
    {
      query: vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      filter: {
        must: [
          { key: 'dismissed', match: { value: true } },
          { key: 'project_id', match: { value: projectId } },
        ],
      },
    },
    { headers: qdrantHeaders(), timeout: 20_000 },
  );

  return (response.data?.result?.points || []).map((p) => ({
    score: Number(p.score || 0),
    payload: p.payload || {},
  }));
}

// ─── Fix Embeddings (Phase 2d) ──────────────────────────────────────────────

/**
 * Store an embedding for a successful fix (merged PR).
 * Called when fixOutcomeTracker detects a PR has been merged.
 *
 * @param {Object} opts
 * @param {string} opts.fixOutcomeId   - fix_outcomes row id (used as Qdrant point id)
 * @param {string} opts.projectId
 * @param {Object} opts.finding        - { category, severity, description, snippet }
 * @param {string} opts.fixDiff        - the diff / patch content
 * @param {string} [opts.language]     - primary language of the project
 * @param {string} [opts.framework]    - detected framework (e.g. "express", "django")
 */
export async function upsertFixEmbedding({
  fixOutcomeId,
  projectId,
  finding,
  fixDiff,
  language = null,
  framework = null,
}) {
  if (!isVectorEnabled()) return { enabled: false, upserted: 0 };
  if (!finding || !fixDiff) return { enabled: true, upserted: 0 };
  const ready = await ensureCollection(env.qdrant.fixCollection);
  if (!ready) return { enabled: true, upserted: 0 };

  const text = buildFixEmbeddingText(finding, fixDiff);
  const [vector] = await embedTexts({ apiKey: env.openAi.apiKey, texts: [text] });
  if (!vector) return { enabled: true, upserted: 0 };

  const base = qdrantBase();
  await axios.put(
    `${base}/collections/${encodeURIComponent(env.qdrant.fixCollection)}/points`,
    {
      points: [
        {
          id: fixOutcomeId,
          vector,
          payload: {
            project_id: projectId,
            category: finding.category || null,
            severity: finding.severity || null,
            language: language || null,
            framework: framework || null,
            pr_merged: true,
            fix_diff: String(fixDiff).slice(0, 2000),
            description: finding.description || null,
          },
        },
      ],
    },
    { headers: qdrantHeaders(), timeout: 30_000 },
  );

  return { enabled: true, upserted: 1 };
}

/**
 * Search for similar past fixes that were successfully merged.
 * Used by the resolution agent to augment fix generation prompts.
 *
 * @param {Object} opts
 * @param {Object} opts.finding   - { category, severity, description, snippet }
 * @param {number} [opts.limit]   - max results (default 3)
 * @param {number} [opts.scoreThreshold] - minimum similarity (default 0.80)
 * @param {string} [opts.language] - filter by language if provided
 * @returns {Array<{score: number, payload: Object}>}
 */
export async function searchSimilarFixes({
  finding,
  limit = 3,
  scoreThreshold = 0.80,
  language = null,
}) {
  if (!isVectorEnabled()) return [];
  if (!finding) return [];
  const ready = await ensureCollection(env.qdrant.fixCollection);
  if (!ready) return [];

  const text = buildFixEmbeddingText(finding, '');
  const [vector] = await embedTexts({ apiKey: env.openAi.apiKey, texts: [text] });
  if (!vector) return [];

  const mustFilters = [{ key: 'pr_merged', match: { value: true } }];
  if (language) {
    mustFilters.push({ key: 'language', match: { value: language } });
  }

  const base = qdrantBase();
  const response = await axios.post(
    `${base}/collections/${encodeURIComponent(env.qdrant.fixCollection)}/points/query`,
    {
      query: vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      filter: { must: mustFilters },
    },
    { headers: qdrantHeaders(), timeout: 20_000 },
  );

  return (response.data?.result?.points || []).map((p) => ({
    score: Number(p.score || 0),
    payload: p.payload || {},
  }));
}

// ─── Code Pattern Embeddings (Phase 2) ──────────────────────────────────────

/**
 * Embed code snippets from findings so we can detect similar vulnerable
 * patterns across projects even when variable names differ.
 *
 * @param {Object} opts
 * @param {Array} opts.findings   - findings with snippet + filePath
 * @param {string} opts.projectId
 * @param {string} opts.scanId
 */
export async function upsertCodePatternEmbeddings({
  findings,
  projectId,
  scanId,
}) {
  if (!isVectorEnabled()) return { enabled: false, upserted: 0 };
  if (!Array.isArray(findings) || findings.length === 0) return { enabled: true, upserted: 0 };

  // Only embed findings that actually have code snippets
  const withSnippets = findings.filter((f) => f.snippet && String(f.snippet).trim().length > 20);
  if (withSnippets.length === 0) return { enabled: true, upserted: 0 };

  const ready = await ensureCollection(env.qdrant.codePatternCollection);
  if (!ready) return { enabled: true, upserted: 0 };

  const items = withSnippets.slice(0, 200);
  const texts = items.map((f) =>
    buildCodePatternEmbeddingText({
      snippet: f.snippet,
      filePath: f.filePath,
      language: detectLanguage(f.filePath),
    }),
  );
  const vectors = await embedTexts({ apiKey: env.openAi.apiKey, texts });

  const points = items.map((f, i) => ({
    id: deterministicUuid(`cp:${scanId}:${f.fingerprint || f.id || i}`),
    vector: vectors[i],
    payload: {
      project_id: projectId,
      scan_id: scanId,
      file_path: f.filePath || null,
      line_start: f.lineNumber || null,
      language: detectLanguage(f.filePath),
      has_vulnerability: true,
      vulnerability_category: f.category || null,
      severity: f.severity || null,
      is_safe_pattern: false,
    },
  }));

  const base = qdrantBase();
  await axios.put(
    `${base}/collections/${encodeURIComponent(env.qdrant.codePatternCollection)}/points`,
    { points },
    { headers: qdrantHeaders(), timeout: 30_000 },
  );

  return { enabled: true, upserted: points.length };
}

/**
 * Search for code snippets that are structurally similar to known-vulnerable patterns.
 * Used as a pre-filter during scanning to flag suspicious code.
 *
 * @param {Object} opts
 * @param {string} opts.snippet        - the code snippet to check
 * @param {string} [opts.filePath]     - file path for language detection
 * @param {number} [opts.limit]        - max results (default 5)
 * @param {number} [opts.scoreThreshold] - minimum similarity (default 0.88)
 * @returns {Array<{score: number, payload: Object}>}
 */
export async function searchSimilarVulnerablePatterns({
  snippet,
  filePath = null,
  limit = 5,
  scoreThreshold = 0.88,
}) {
  if (!isVectorEnabled()) return [];
  if (!snippet || String(snippet).trim().length < 20) return [];
  const ready = await ensureCollection(env.qdrant.codePatternCollection);
  if (!ready) return [];

  const text = buildCodePatternEmbeddingText({
    snippet,
    filePath,
    language: detectLanguage(filePath),
  });
  const [vector] = await embedTexts({ apiKey: env.openAi.apiKey, texts: [text] });
  if (!vector) return [];

  const base = qdrantBase();
  const response = await axios.post(
    `${base}/collections/${encodeURIComponent(env.qdrant.codePatternCollection)}/points/query`,
    {
      query: vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      filter: {
        must: [{ key: 'has_vulnerability', match: { value: true } }],
      },
    },
    { headers: qdrantHeaders(), timeout: 20_000 },
  );

  return (response.data?.result?.points || []).map((p) => ({
    score: Number(p.score || 0),
    payload: p.payload || {},
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectLanguage(filePath) {
  if (!filePath) return null;
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rb: 'ruby',
    php: 'php',
    rs: 'rust',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    sql: 'sql',
    sh: 'shell', bash: 'shell',
  };
  return map[ext] || null;
}

export { isVectorEnabled };
