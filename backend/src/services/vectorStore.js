import axios from 'axios';
import { env } from '../config/env.js';
import { buildFindingEmbeddingText, embedTexts, EMBEDDING_DIMENSIONS } from './embeddingService.js';

function isVectorEnabled() {
  return Boolean(env.qdrant.url && env.openAi.apiKey);
}

function qdrantHeaders() {
  return env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};
}

async function ensureFindingCollection() {
  const base = env.qdrant.url?.replace(/\/+$/, '');
  if (!base) return false;
  const name = env.qdrant.findingCollection;
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
    console.warn('[vector] ensure collection failed', e?.message || e);
    return false;
  }
}

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
  const ready = await ensureFindingCollection();
  if (!ready) return { enabled: true, upserted: 0 };

  const items = findings.slice(0, 300);
  const texts = items.map(buildFindingEmbeddingText);
  const vectors = await embedTexts({ apiKey: env.openAi.apiKey, texts });
  const points = items.map((f, i) => ({
    id: String(f.id || `${scanId}:${f.fingerprint || i}`),
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

  const base = env.qdrant.url.replace(/\/+$/, '');
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
  const ready = await ensureFindingCollection();
  if (!ready) return [];

  const [vector] = await embedTexts({
    apiKey: env.openAi.apiKey,
    texts: [buildFindingEmbeddingText(finding)],
  });
  if (!vector) return [];

  const base = env.qdrant.url.replace(/\/+$/, '');
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
