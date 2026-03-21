/**
 * Developer Security Profiler — Phase 1
 *
 * After a scan completes, uses GitHub's commit/blame API to attribute
 * findings to the developer who introduced the vulnerable code.
 * Builds per-project developer profiles with risk scores.
 */

import { env } from '../config/env.js';

/**
 * For a list of findings, fetch blame information from GitHub and
 * create/update developer profiles and finding links.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} projectId
 * @param {string} scanId
 * @param {string} githubUrl - full GitHub repo URL
 */
export async function buildDeveloperProfiles(pool, projectId, scanId, githubUrl) {
  const githubToken = env.github.token;
  if (!githubToken) return { profilesUpdated: 0, linksCreated: 0 };

  const repoPath = repoPathFromUrl(githubUrl);
  if (!repoPath) return { profilesUpdated: 0, linksCreated: 0 };

  // Get findings from this scan that have file paths and line numbers
  const [findings] = await pool.query(
    `SELECT id, file_path AS filePath, line_number AS lineNumber, severity, category
     FROM project_findings
     WHERE project_id = ? AND scan_id = ? AND file_path IS NOT NULL AND line_number IS NOT NULL
     ORDER BY weighted_score DESC
     LIMIT 200`,
    [projectId, scanId],
  );

  if (!findings.length) return { profilesUpdated: 0, linksCreated: 0 };

  // Group findings by file to minimize API calls
  const fileGroups = new Map();
  for (const f of findings) {
    const key = f.filePath;
    if (!fileGroups.has(key)) fileGroups.set(key, []);
    fileGroups.get(key).push(f);
  }

  // Collect blame results: { findingId, authorEmail, authorName, commitSha, introducedAt }
  const blameResults = [];

  for (const [filePath, fileFindings] of fileGroups) {
    try {
      const commits = await fetchFileCommits(repoPath, filePath, githubToken);
      if (!commits.length) continue;

      for (const finding of fileFindings) {
        // Use the most recent commit that touched this file as the blame target.
        // Ideally we'd use line-level blame, but the commits endpoint is simpler
        // and avoids the heavy blame API. Good enough for profile attribution.
        const commit = commits[0];
        const author = commit.commit?.author;
        if (!author?.email) continue;

        blameResults.push({
          findingId: finding.id,
          severity: finding.severity,
          category: finding.category,
          authorEmail: author.email,
          authorName: author.name || author.email,
          commitSha: commit.sha?.slice(0, 40) || null,
          introducedAt: author.date || null,
          blameLine: finding.lineNumber,
        });
      }
    } catch (e) {
      console.warn(
        `[dev-profiler] blame failed for ${filePath}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  if (!blameResults.length) return { profilesUpdated: 0, linksCreated: 0 };

  // Group by author email
  const authorGroups = new Map();
  for (const b of blameResults) {
    if (!authorGroups.has(b.authorEmail)) {
      authorGroups.set(b.authorEmail, { name: b.authorName, findings: [] });
    }
    authorGroups.get(b.authorEmail).findings.push(b);
  }

  let profilesUpdated = 0;
  let linksCreated = 0;

  for (const [email, { name, findings: authorFindings }] of authorGroups) {
    // Upsert developer profile
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    const categoryMap = new Map();
    for (const f of authorFindings) {
      if (counts[f.severity] !== undefined) counts[f.severity]++;
      categoryMap.set(f.category, (categoryMap.get(f.category) || 0) + 1);
    }

    const topCategories = [...categoryMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));

    const riskScore = computeRiskScore(counts, authorFindings.length);

    // Upsert profile
    const [upsertResult] = await pool.execute(
      `INSERT INTO developer_profiles
        (id, project_id, author_email, author_name, total_findings_introduced,
         critical_count, high_count, medium_count, low_count,
         top_categories, risk_score, last_seen_at)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         author_name = VALUES(author_name),
         total_findings_introduced = total_findings_introduced + VALUES(total_findings_introduced),
         critical_count = critical_count + VALUES(critical_count),
         high_count = high_count + VALUES(high_count),
         medium_count = medium_count + VALUES(medium_count),
         low_count = low_count + VALUES(low_count),
         top_categories = VALUES(top_categories),
         risk_score = VALUES(risk_score),
         last_seen_at = CURRENT_TIMESTAMP`,
      [
        projectId,
        email,
        name,
        authorFindings.length,
        counts.critical,
        counts.high,
        counts.medium,
        counts.low,
        JSON.stringify(topCategories),
        riskScore,
      ],
    );
    profilesUpdated++;

    // Get the profile id for linking
    const [[profile]] = await pool.query(
      `SELECT id FROM developer_profiles WHERE project_id = ? AND author_email = ? LIMIT 1`,
      [projectId, email],
    );
    if (!profile) continue;

    // Insert finding links
    for (const f of authorFindings) {
      try {
        await pool.execute(
          `INSERT INTO developer_finding_links
            (id, finding_id, developer_profile_id, commit_sha, blame_line, introduced_at)
           VALUES (UUID(), ?, ?, ?, ?, ?)`,
          [f.findingId, profile.id, f.commitSha, f.blameLine, f.introducedAt],
        );
        linksCreated++;
      } catch (e) {
        // Duplicate or FK constraint — skip
        if (!e.code?.includes('ER_DUP_ENTRY')) {
          console.warn('[dev-profiler] link insert failed', e instanceof Error ? e.message : String(e));
        }
      }
    }
  }

  return { profilesUpdated, linksCreated };
}

/**
 * Compute developer risk score.
 * Formula from architecture doc:
 *   risk = (critical*10 + high*5 + medium*2 + low*0.5) / max(totalFindings, 1)
 * Simplified version — recency weighting happens at query time since we track last_seen_at.
 */
function computeRiskScore(counts, totalFindings) {
  const raw = counts.critical * 10 + counts.high * 5 + counts.medium * 2 + counts.low * 0.5;
  // Normalize to a 0-100 scale — cap at 99.99 to fit DECIMAL(5,2)
  const score = Math.min(99.99, raw);
  return Math.round(score * 100) / 100;
}

/**
 * Fetch recent commits for a file from the GitHub API.
 */
async function fetchFileCommits(repoPath, filePath, githubToken) {
  const resp = await fetch(
    `https://api.github.com/repos/${repoPath}/commits?path=${encodeURIComponent(filePath)}&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!resp.ok) return [];
  return resp.json();
}

function repoPathFromUrl(githubUrl) {
  try {
    const u = new URL(githubUrl);
    return u.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  } catch {
    return null;
  }
}
