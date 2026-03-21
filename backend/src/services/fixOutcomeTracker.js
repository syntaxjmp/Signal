/**
 * Fix Outcome Tracker — Phase 1c
 *
 * Tracks what happens to PRs created by the resolution agent:
 * 1. Creates a fix_outcomes row when a resolution job completes with a PR URL
 * 2. Polls GitHub API periodically to check if open PRs have been merged or closed
 */

import { env } from '../config/env.js';

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
     VALUES (UUID(), ?, ?, ?, 'open', ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
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
 * Poll GitHub for all open fix_outcomes and update their status.
 * Returns { updated: number } with how many rows were changed.
 */
export async function pollFixOutcomes(pool) {
  const githubToken = env.github.token;
  if (!githubToken) return { updated: 0 };

  const [openOutcomes] = await pool.query(
    `SELECT id, pr_url AS prUrl
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
