import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-large';
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

export function buildFixEmbeddingText(finding, diff) {
  return [
    `Vulnerability: ${finding.category || 'General'} — ${finding.description || ''}`,
    `Severity: ${finding.severity || 'low'}`,
    finding.snippet ? `Vulnerable code:\n${String(finding.snippet).slice(0, 400)}` : '',
    `Fix diff:\n${String(diff).slice(0, 1000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildCodePatternEmbeddingText({ snippet, filePath, language }) {
  return [
    language ? `Language: ${language}` : '',
    filePath ? `File: ${filePath}` : '',
    `Code:\n${String(snippet).slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };
