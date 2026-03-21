import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

export function buildFindingEmbeddingText(finding) {
  return [
    `Category: ${finding.category || 'General'}`,
    `Severity: ${finding.severity || 'low'}`,
    `Description: ${finding.description || ''}`,
    finding.snippet ? `Code:\n${String(finding.snippet).slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function embedTexts({ apiKey, texts }) {
  if (!apiKey || !Array.isArray(texts) || texts.length === 0) return [];
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };
