import OpenAI from 'openai';
import { explainFindingPrompt } from '../ai/explainFindingPrompt.js';

/**
 * Generate a junior-dev-friendly explanation of a security finding.
 * @param {{ finding: { severity?: string; category?: string; description?: string; filePath?: string; lineNumber?: number; snippet?: string }; openAiApiKey: string; openAiModel?: string }} options
 */
export async function explainFindingToUser({
  finding,
  openAiApiKey,
  openAiModel = 'gpt-4o-mini',
}) {
  if (!openAiApiKey?.trim()) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const client = new OpenAI({ apiKey: openAiApiKey });

  const f = finding || {};
  const userPayload = [
    `**Finding:** ${String(f.category || 'Security issue').trim()}`,
    `**Severity:** ${String(f.severity || 'unknown').trim()}`,
    `**Description:** ${String(f.description || 'No description').trim()}`,
  ];
  if (f.filePath) {
    userPayload.push(`**File:** ${f.filePath}${f.lineNumber != null ? ` (line ${f.lineNumber})` : ''}`);
  }
  if (f.snippet) {
    userPayload.push(`\n**Code snippet:**\n\`\`\`\n${String(f.snippet).slice(0, 2000)}\n\`\`\``);
  }

  const response = await client.chat.completions.create({
    model: openAiModel,
    temperature: 0.3,
    messages: [
      { role: 'system', content: explainFindingPrompt },
      { role: 'user', content: userPayload.join('\n') },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  return { explanation: typeof content === 'string' ? content.trim() : '' };
}
