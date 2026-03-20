import express, { Router } from 'express';
import { env } from '../config/env.js';
import { extensionScanSnippet, extensionScanWorkspaceFiles } from '../services/projectScanner.js';

export const extensionScanRouter = Router();

const workspaceJson = express.json({ limit: '25mb' });

extensionScanRouter.post('/snippet-scan', async (req, res, next) => {
  try {
    if (!env.openAi.apiKey) {
      res.status(503).json({ error: 'OpenAI API key not configured (OPENAI_API_KEY)' });
      return;
    }
    const { code, languageId, filePath } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: 'code is required (non-empty string)' });
      return;
    }
    const result = await extensionScanSnippet({
      code,
      languageId: typeof languageId === 'string' ? languageId : 'text',
      filePath: typeof filePath === 'string' ? filePath : 'selection',
      openAiApiKey: env.openAi.apiKey,
      openAiModel: env.openAi.model,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

extensionScanRouter.post('/workspace-scan', workspaceJson, async (req, res, next) => {
  try {
    if (!env.openAi.apiKey) {
      res.status(503).json({ error: 'OpenAI API key not configured (OPENAI_API_KEY)' });
      return;
    }
    const { files } = req.body || {};
    if (!Array.isArray(files)) {
      res.status(400).json({ error: 'files must be an array of { path, content }' });
      return;
    }
    const capped = files.slice(0, env.scan.maxFiles);
    const result = await extensionScanWorkspaceFiles({
      files: capped,
      openAiApiKey: env.openAi.apiKey,
      openAiModel: env.openAi.model,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
