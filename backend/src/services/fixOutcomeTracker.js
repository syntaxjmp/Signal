/**
 * Fix Outcome Tracker — Phase 1c + Phase 2d
 *
 * Tracks what happens to PRs created by the resolution agent:
 * 1. Creates a fix_outcomes row when a resolution job completes with a PR URL
 * 2. Polls GitHub API periodically to check if open PRs have been merged or closed
 * 3. When a PR is merged, fetches the diff and embeds it in Qdrant for future fix augmentation
 */

import { env } from '../config/env.js';
import { upsertFixEmbedding } from './vectorStore.js';

/**
 * Create a fix_outcomes record for a completed resolution job.
 * Called from the resolution job completion path.
 */
export async function createFixOutcome(pool, { jobId, projectId, prUrl, findingIds }) {
  // Determine the primary fix category from the findings
  let fixCategory = null;
  if (findingIds?.length) {
    const placeholders = findingIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT category, COUNT(*) AS cnt
       FROM project_findings
       WHERE id IN (${placeholders})
       GROUP BY category
       ORDER BY cnt DESC
       LIMIT 1`,
      findingIds,
    );
    fixCategory = rows?.[0]?.category ?? null;
  }

  await pool.execute(
    `INSERT INTO fix_outcomes
      (id, resolution_job_id, project_id, pr_url, pr_status, fix_category, files_changed)
     VALUES (UUID(), ?, ?, ?, 'open', ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       pr_url = new_row.pr_url,
       fix_category = new_row.fix_category,
       files_changed = new_row.files_changed,
       updated_at = CURRENT_TIMESTAMP`,
    [jobId, projectId, prUrl, fixCategory, findingIds?.length ?? 0],
  );
}

/**
 * Extract owner/repo and PR number from a GitHub PR URL.
 * e.g. "https://github.com/owner/repo/pull/42" → { owner: "owner", repo: "repo", prNumber: 42 }
 */
function parsePrUrl(prUrl) {
  try {
    const u = new URL(prUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // Expected: [owner, repo, "pull", number]
    if (parts.length >= 4 && parts[2] === 'pull') {
      return { owner: parts[0], repo: parts[1], prNumber: Number(parts[3]) };
    }
  } catch {
    // invalid URL
  }
  return null;
}

/**
 * Fetch the diff for a merged PR from GitHub.
 */
async function fetchPrDiff({ owner, repo, prNumber, githubToken }) {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3.diff',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!resp.ok) return null;
  return resp.text();
}

/**
 * When a PR is merged, embed the fix (finding + diff) into Qdrant
 * so the resolution agent can reference similar past fixes.
 */
async function embedMergedFix(pool, { outcomeId, projectId, parsed, githubToken }) {
  try {
    // Fetch the PR diff
    const diff = await fetchPrDiff({
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      githubToken,
    });
    if (!diff) return;

    // Get the primary finding associated with this fix outcome
    const [[outcome]] = await pool.query(
      `SELECT fo.id, fo.fix_category, fo.resolution_job_id,
              rj.finding_ids AS findingIdsJson
       FROM fix_outcomes fo
       JOIN resolution_jobs rj ON rj.id = fo.resolution_job_id
       WHERE fo.id = ?
       LIMIT 1`,
      [outcomeId],
    );
    if (!outcome) return;

    let findingIds = [];
    try {
      findingIds = JSON.parse(outcome.findingIdsJson || '[]');
    } catch {
      return;
    }
    if (!findingIds.length) return;

    // Get the first finding for embedding (representative of the fix)
    const placeholders = findingIds.map(() => '?').join(',');
    const [findings] = await pool.query(
      `SELECT id, category, severity, description, snippet, file_path AS filePath
       FROM project_findings
       WHERE id IN (${placeholders})
       ORDER BY weighted_score DESC
       LIMIT 1`,
      findingIds,
    );
    if (!findings.length) return;

    const finding = findings[0];

    await upsertFixEmbedding({
      fixOutcomeId: outcomeId,
      projectId,
      finding: {
        category: finding.category,
        severity: finding.severity,
        description: finding.description,
        snippet: finding.snippet,
      },
      fixDiff: diff,
    });

    console.info(
      `[fix-embeddings] embedded merged fix outcome=${outcomeId} category=${finding.category}`,
    );
  } catch (e) {
    console.warn(
      `[fix-embeddings] non-fatal: failed to embed merged fix outcome=${outcomeId}`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Poll GitHub for all open fix_outcomes and update their status.
 * When a PR is merged, also embed the fix diff for future augmentation.
 * Returns { updated: number } with how many rows were changed.
 */
export async function pollFixOutcomes(pool) {
  const githubToken = env.github.token;
  if (!githubToken) return { updated: 0 };

  const [openOutcomes] = await pool.query(
    `SELECT id, pr_url AS prUrl, project_id AS projectId
     FROM fix_outcomes
     WHERE pr_status = 'open'
     ORDER BY created_at ASC
     LIMIT 50`,
  );

  if (!openOutcomes.length) return { updated: 0 };

  let updated = 0;

  for (const outcome of openOutcomes) {
    const parsed = parsePrUrl(outcome.prUrl);
    if (!parsed) continue;

    try {
      const resp = await fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!resp.ok) continue;

      const pr = await resp.json();
      const state = pr.state; // "open" | "closed"
      const merged = pr.merged === true;

      if (merged) {
        await pool.execute(
          `UPDATE fix_outcomes
           SET pr_status = 'merged',
               merged_at = ?,
               review_comments_count = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [pr.merged_at || new Date().toISOString(), pr.review_comments ?? 0, outcome.id],
        );
        updated++;

        // Phase 2d: embed the merged fix for future augmentation
        void embedMergedFix(pool, {
          outcomeId: outcome.id,
          projectId: outcome.projectId,
          parsed,
          githubToken,
        });
      } else if (state === 'closed') {
        await pool.execute(
          `UPDATE fix_outcomes
           SET pr_status = 'closed',
               closed_at = ?,
               review_comments_count = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [pr.closed_at || new Date().toISOString(), pr.review_comments ?? 0, outcome.id],
        );
        updated++;
      } else if (state === 'open') {
        // Update review comment count while still open
        await pool.execute(
          `UPDATE fix_outcomes
           SET review_comments_count = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [pr.review_comments ?? 0, outcome.id],
        );
      }
    } catch (e) {
      console.warn(
        `[fix-outcomes] failed to poll PR ${outcome.prUrl}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return { updated };
}
