import axios from 'axios';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config/database.js';
import { env } from '../config/env.js';
import { resolveAgentPrompt } from '../ai/resolveAgentPrompt.js';
import { sendWebhookForUser } from './webhookHandler.js';
import { createFixOutcome } from './fixOutcomeTracker.js';

/**
 * Build common GitHub API headers.
 */
function ghHeaders(githubToken) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  return headers;
}

/**
 * Fork the repo into the authenticated user's account.
 * Returns the fork owner login. If a fork already exists, GitHub returns it.
 */
async function forkRepo({ owner, repo, githubToken }) {
  const resp = await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/forks`,
    { default_branch_only: true },
    { headers: ghHeaders(githubToken), timeout: 60_000 },
  );
  return resp.data.owner.login;
}

/**
 * Wait until the fork is ready (GitHub forks are async; the repo may 404 briefly).
 */
async function waitForFork({ forkOwner, repo, githubToken, maxAttempts = 15, intervalMs = 2000 }) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await axios.get(`https://api.github.com/repos/${forkOwner}/${repo}`, {
        headers: ghHeaders(githubToken),
        timeout: 15_000,
      });
      return;
    } catch (err) {
      if (err?.response?.status !== 404) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Fork ${forkOwner}/${repo} not ready after ${maxAttempts * intervalMs / 1000}s`);
}

/**
 * Parse a GitHub URL into { owner, repo }.
 */
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

/**
 * Fetch file content from GitHub Contents API.
 */
async function fetchFileContent({ owner, repo, filePath, githubToken }) {
  const headers = {
    Accept: 'application/vnd.github.v3.raw',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const resp = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    { headers, timeout: 30_000 },
  );
  return resp.data;
}

/**
 * Get the SHA of the default branch.
 */
async function getDefaultBranchSha({ owner, repo, githubToken }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
    timeout: 30_000,
  });
  const defaultBranch = resp.data.default_branch;

  const refResp = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
    { headers, timeout: 30_000 },
  );

  return { defaultBranch, sha: refResp.data.object.sha };
}

/**
 * Create a new branch from a given SHA.
 */
async function createBranch({ owner, repo, branchName, sha, githubToken }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    { ref: `refs/heads/${branchName}`, sha },
    { headers, timeout: 30_000 },
  );
}

/**
 * Commit a file update to a branch.
 */
async function commitFile({ owner, repo, branchName, filePath, content, message, githubToken }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  // Get the current file SHA for the update
  const getResp = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branchName}`,
    { headers, timeout: 30_000 },
  );
  const fileSha = getResp.data.sha;

  await axios.put(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: fileSha,
      branch: branchName,
    },
    { headers, timeout: 30_000 },
  );
}

/**
 * Create a pull request.
 */
async function createPullRequest({ owner, repo, branchName, baseBranch, title, body, githubToken }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'signal-resolver',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const resp = await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    { title, body, head: branchName, base: baseBranch },
    { headers, timeout: 30_000 },
  );

  return resp.data.html_url;
}

/**
 * Ask the LLM to produce a fixed version of the file.
 */
async function getFixedFileContent({ fileContent, filePath, findings, openAiApiKey, openAiModel }) {
  const client = new OpenAI({ apiKey: openAiApiKey });

  const findingsDescription = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.category}: ${f.description}` +
        (f.lineNumber ? ` (line ${f.lineNumber})` : ''),
    )
    .join('\n');

  const response = await client.chat.completions.create({
    model: openAiModel,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: resolveAgentPrompt,
      },
      {
        role: 'user',
        content: `Fix the following security vulnerabilities in this file.

File: ${filePath}

Vulnerabilities found by the scanner:
${findingsDescription}

Current file content:
${fileContent}`,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content || '';
  // Strip markdown fences if the model wraps the output
  return content.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
}

/**
 * Run the resolution job: fix findings and create a PR.
 */
export async function runResolutionJob({ jobId, projectId, findingIds, githubUrl, githubToken, openAiApiKey }) {
  const pool = getPool();
  const openAiModel = env.openAi.model;
  let jobUserId = null;

  try {
    const [[jobRow]] = await pool.query(`SELECT user_id AS userId FROM resolution_jobs WHERE id = ? LIMIT 1`, [jobId]);
    jobUserId = jobRow?.userId ?? null;

    await pool.execute(
      `UPDATE resolution_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [jobId],
    );

    // Mark targeted findings as in_progress
    if (findingIds.length > 0) {
      const placeholders = findingIds.map(() => '?').join(',');
      await pool.execute(
        `UPDATE project_findings SET status = 'in_progress' WHERE id IN (${placeholders}) AND project_id = ?`,
        [...findingIds, projectId],
      );
    }

    const parsed = parseGitHubUrl(githubUrl);
    if (!parsed) throw new Error('Invalid GitHub URL');
    const { owner, repo } = parsed;
    console.info(`[resolve] job=${jobId} parsed repo=${owner}/${repo} findingIds=${findingIds.length}`);

    // Fetch findings from DB
    const placeholders = findingIds.map(() => '?').join(',');
    const [findings] = await pool.query(
      `SELECT id, severity, category, description, line_number AS lineNumber, file_path AS filePath, snippet
       FROM project_findings
       WHERE id IN (${placeholders}) AND project_id = ?`,
      [...findingIds, projectId],
    );

    if (findings.length === 0) throw new Error('No findings to resolve');
    console.info(`[resolve] job=${jobId} fetched ${findings.length} findings from DB`);

    // Group findings by file path
    const byFile = new Map();
    for (const f of findings) {
      const key = f.filePath;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(f);
    }

    // Fork the repo (works even if user doesn't have write access to the original)
    console.info(`[resolve] forking ${owner}/${repo}…`);
    const forkOwner = await forkRepo({ owner, repo, githubToken });
    console.info(`[resolve] fork owner=${forkOwner}, waiting for fork to be ready…`);
    await waitForFork({ forkOwner, repo, githubToken });
    console.info(`[resolve] fork ready: ${forkOwner}/${repo}`);

    // Get the default branch SHA from the *original* repo
    console.info(`[resolve] job=${jobId} fetching default branch SHA from ${owner}/${repo}…`);
    const { defaultBranch, sha } = await getDefaultBranchSha({ owner, repo, githubToken });
    const branchName = `signal/fix-${jobId.slice(0, 8)}`;
    console.info(`[resolve] job=${jobId} defaultBranch=${defaultBranch} sha=${sha.slice(0, 8)}`);

    // Create the branch on the *fork*
    console.info(`[resolve] job=${jobId} creating branch ${branchName} on ${forkOwner}/${repo}…`);
    await createBranch({ owner: forkOwner, repo, branchName, sha, githubToken });
    console.info(`[resolve] job=${jobId} branch created`);

    await pool.execute(
      `UPDATE resolution_jobs SET branch_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [branchName, jobId],
    );

    const fixedFiles = [];
    const skippedFindingIds = [];

    // Phase 1: Fetch file contents and generate LLM fixes in parallel
    const fileEntries = [...byFile.entries()];
    const fixResults = await Promise.allSettled(
      fileEntries.map(async ([filePath, fileFindings]) => {
        console.info(`[resolve] job=${jobId} fetching file content: ${filePath}`);
        const fileContent = await fetchFileContent({ owner, repo, filePath, githubToken });
        console.info(`[resolve] job=${jobId} fetched ${filePath} (${String(fileContent).length} chars), sending to LLM…`);

        const fixedContent = await getFixedFileContent({
          fileContent,
          filePath,
          findings: fileFindings,
          openAiApiKey,
          openAiModel,
        });

        return { filePath, fileFindings, fileContent, fixedContent };
      }),
    );

    // Phase 2: Commit fixes sequentially (each commit updates the branch HEAD)
    for (let i = 0; i < fixResults.length; i++) {
      const result = fixResults[i];
      const [filePath, fileFindings] = fileEntries[i];

      if (result.status === 'rejected') {
        const fileErr = result.reason;
        if (fileErr?.response) {
          console.warn(`[resolve] failed to fix ${filePath}: status=${fileErr.response.status} url=${fileErr.config?.url}`, fileErr.response.data);
        } else {
          console.warn(`[resolve] failed to fix ${filePath}:`, fileErr?.message);
        }
        skippedFindingIds.push(...fileFindings.map((f) => f.id));
        continue;
      }

      const { fileContent, fixedContent } = result.value;

      // Skip if the LLM returned identical content (nothing to fix)
      if (fixedContent.trim() === String(fileContent).trim()) {
        skippedFindingIds.push(...fileFindings.map((f) => f.id));
        continue;
      }

      try {
        console.info(`[resolve] job=${jobId} LLM returned fix for ${filePath}, committing to fork…`);
        const commitMsg = `fix: resolve ${fileFindings.length} security finding(s) in ${filePath}`;
        await commitFile({
          owner: forkOwner,
          repo,
          branchName,
          filePath,
          content: fixedContent,
          message: commitMsg,
          githubToken,
        });
        console.info(`[resolve] job=${jobId} committed fix for ${filePath}`);
        fixedFiles.push({ filePath, findingCount: fileFindings.length });
      } catch (commitErr) {
        if (commitErr?.response) {
          console.warn(`[resolve] failed to commit ${filePath}: status=${commitErr.response.status}`, commitErr.response.data);
        } else {
          console.warn(`[resolve] failed to commit ${filePath}:`, commitErr?.message);
        }
        skippedFindingIds.push(...fileFindings.map((f) => f.id));
      }
    }

    if (fixedFiles.length === 0) {
      throw new Error('Could not generate fixes for any of the targeted files');
    }

    // Create a cross-fork PR: head = forkOwner:branchName → base = owner:defaultBranch
    console.info(`[resolve] job=${jobId} creating PR: ${forkOwner}:${branchName} → ${owner}:${defaultBranch} (${fixedFiles.length} files fixed, ${skippedFindingIds.length} skipped)`);
    const prBody = [
      '## Security Fixes',
      '',
      `This PR was automatically generated by **Signal** to resolve ${findings.length} security finding(s).`,
      '',
      '### Files modified',
      ...fixedFiles.map((f) => `- \`${f.filePath}\` — ${f.findingCount} finding(s)`),
      '',
      '> **Review carefully before merging.** AI-generated fixes should be validated.',
    ].join('\n');

    const prUrl = await createPullRequest({
      owner,
      repo,
      branchName: `${forkOwner}:${branchName}`,
      baseBranch: defaultBranch,
      title: `fix: resolve ${findings.length} security finding(s) [Signal]`,
      body: prBody,
      githubToken,
    });

    // Mark resolved findings
    const resolvedIds = findings
      .filter((f) => !skippedFindingIds.includes(f.id))
      .map((f) => f.id);

    if (resolvedIds.length > 0) {
      const ph = resolvedIds.map(() => '?').join(',');
      await pool.execute(
        `UPDATE project_findings SET status = 'resolved' WHERE id IN (${ph})`,
        resolvedIds,
      );
    }

    // Revert skipped findings back to open
    if (skippedFindingIds.length > 0) {
      const ph = skippedFindingIds.map(() => '?').join(',');
      await pool.execute(
        `UPDATE project_findings SET status = 'open' WHERE id IN (${ph})`,
        skippedFindingIds,
      );
    }

    await pool.execute(
      `UPDATE resolution_jobs SET status = 'completed', pr_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [prUrl, jobId],
    );

    // Track fix outcome for PR status monitoring
    try {
      await createFixOutcome(pool, { jobId, projectId, prUrl, findingIds: resolvedIds });
    } catch (fixErr) {
      console.warn('[fix-outcomes] non-fatal: failed to create fix outcome', fixErr instanceof Error ? fixErr.message : String(fixErr));
    }

    if (jobUserId) {
      void sendWebhookForUser(jobUserId, {
        title: 'Resolve Job Completed',
        description: 'Signal Bot created a pull request for your resolved findings.',
        fields: [
          { name: 'Project ID', value: projectId, inline: true },
          { name: 'Job ID', value: jobId, inline: true },
          { name: 'Resolved Findings', value: String(resolvedIds.length), inline: true },
          { name: 'Pull Request', value: prUrl, inline: false },
        ],
        url: prUrl,
      });
    }

    console.info(`[resolve] completed job=${jobId} pr=${prUrl}`);
  } catch (e) {
    // Revert findings back to open on failure
    if (findingIds.length > 0) {
      try {
        const ph = findingIds.map(() => '?').join(',');
        await pool.execute(
          `UPDATE project_findings SET status = 'open' WHERE id IN (${ph}) AND status = 'in_progress'`,
          findingIds,
        );
      } catch {
        // no-op
      }
    }

    try {
      await pool.execute(
        `UPDATE resolution_jobs SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [String(e?.message || e), jobId],
      );
    } catch {
      // no-op
    }
    if (e?.response) {
      console.error(`[resolve] failed job=${jobId} status=${e.response.status} url=${e.config?.url}`, e.response.data);
    } else {
      console.error(`[resolve] failed job=${jobId}`, e);
    }
  }
}
