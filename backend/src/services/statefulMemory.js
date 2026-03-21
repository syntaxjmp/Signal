/**
 * Stateful memory (MySQL-only):
 * - exact dismissal matching
 * - regression detection (resolved finding reappears)
 * - rolling baseline recalculation
 * - accepted risk management & invalidation
 */

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const variance = nums.reduce((acc, n) => acc + (n - m) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

export async function recomputeScanBaseline(pool, projectId, windowSize = 10) {
  const [rows] = await pool.query(
    `SELECT security_score AS securityScore, findings_count AS findingsCount
     FROM project_scans
     WHERE project_id = ? AND status = 'completed' AND security_score IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ?`,
    [projectId, windowSize],
  );

  if (!rows.length) return null;

  const scores = rows.map((r) => Number(r.securityScore || 0));
  const findingCounts = rows.map((r) => Number(r.findingsCount || 0));
  const baselineScore = mean(scores);
  const baselineFindingCount = Math.round(mean(findingCounts));
  const scoreStddev = stddev(scores);

  await pool.execute(
    `INSERT INTO scan_baselines
      (id, project_id, baseline_score, baseline_finding_count, score_stddev, window_size, last_recalculated_at)
     VALUES (UUID(), ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
      baseline_score = VALUES(baseline_score),
      baseline_finding_count = VALUES(baseline_finding_count),
      score_stddev = VALUES(score_stddev),
      window_size = VALUES(window_size),
      last_recalculated_at = CURRENT_TIMESTAMP`,
    [projectId, baselineScore, baselineFindingCount, scoreStddev, windowSize],
  );

  return {
    baselineScore: Math.round(baselineScore * 100) / 100,
    baselineFindingCount,
    scoreStddev: Math.round(scoreStddev * 1000) / 1000,
    windowSize: Math.min(windowSize, rows.length),
  };
}

export async function detectAndStoreRegressions(pool, projectId, scanId) {
  const [insertResult] = await pool.execute(
    `INSERT INTO finding_regressions
      (id, fingerprint, project_id, resolved_in_scan_id, reappeared_in_scan_id, original_finding_id, new_finding_id)
     SELECT
       UUID(),
       cur.fingerprint,
       cur.project_id,
       prev.scan_id AS resolved_in_scan_id,
       cur.scan_id AS reappeared_in_scan_id,
       prev.id AS original_finding_id,
       cur.id AS new_finding_id
     FROM project_findings cur
     JOIN (
       SELECT ranked.fingerprint, ranked.scan_id, ranked.id
       FROM (
         SELECT
           pf.fingerprint,
           pf.scan_id,
           pf.id,
           ROW_NUMBER() OVER (PARTITION BY pf.fingerprint ORDER BY ps.created_at DESC) AS rn
         FROM project_findings pf
         JOIN project_scans ps ON ps.id = pf.scan_id
         WHERE pf.project_id = ?
           AND pf.status = 'resolved'
           AND ps.created_at < (SELECT created_at FROM project_scans WHERE id = ? LIMIT 1)
       ) ranked
       WHERE ranked.rn = 1
     ) prev ON prev.fingerprint = cur.fingerprint
     LEFT JOIN finding_regressions fr
       ON fr.project_id = cur.project_id
      AND fr.fingerprint = cur.fingerprint
      AND fr.reappeared_in_scan_id = cur.scan_id
     WHERE cur.project_id = ?
       AND cur.scan_id = ?
       AND fr.id IS NULL`,
    [projectId, scanId, projectId, scanId],
  );

  return Number(insertResult?.affectedRows || 0);
}

export async function buildScanMemoryContext(pool, projectId, scanId) {
  const [[[dismissalMatchesRow]], [[regressionCountRow]], [[baselineRow]]] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS n
       FROM project_findings cur
       JOIN finding_dismissals d
         ON d.project_id = cur.project_id
        AND d.fingerprint = cur.fingerprint
        AND d.is_active = 1
       WHERE cur.project_id = ? AND cur.scan_id = ?`,
      [projectId, scanId],
    ),
    pool.query(
      `SELECT COUNT(*) AS n
       FROM finding_regressions
       WHERE project_id = ? AND reappeared_in_scan_id = ?`,
      [projectId, scanId],
    ),
    pool.query(
      `SELECT baseline_score AS baselineScore,
              baseline_finding_count AS baselineFindingCount,
              score_stddev AS scoreStddev,
              window_size AS windowSize,
              last_recalculated_at AS lastRecalculatedAt
       FROM scan_baselines
       WHERE project_id = ?
       LIMIT 1`,
      [projectId],
    ),
  ]);

  return {
    dismissalMatches: Number(dismissalMatchesRow?.n || 0),
    regressionsDetected: Number(regressionCountRow?.n || 0),
    baseline: baselineRow
      ? {
          baselineScore: baselineRow.baselineScore == null ? null : Number(baselineRow.baselineScore),
          baselineFindingCount: Number(baselineRow.baselineFindingCount || 0),
          scoreStddev: baselineRow.scoreStddev == null ? null : Number(baselineRow.scoreStddev),
          windowSize: Number(baselineRow.windowSize || 0),
          lastRecalculatedAt: baselineRow.lastRecalculatedAt,
        }
      : null,
  };
}

/**
 * Accept a risk for a finding — stores the acceptance with optional
 * file dependencies and checksums so we can detect invalidation later.
 */
export async function acceptRisk(pool, { fingerprint, projectId, userId, reason, dependsOnFiles, dependsOnChecksums, reviewByDate }) {
  await pool.execute(
    `INSERT INTO accepted_risks
      (id, fingerprint, project_id, accepted_by, reason, depends_on_files, depends_on_checksums, review_by_date, is_valid)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       accepted_by = VALUES(accepted_by),
       reason = VALUES(reason),
       depends_on_files = VALUES(depends_on_files),
       depends_on_checksums = VALUES(depends_on_checksums),
       review_by_date = VALUES(review_by_date),
       is_valid = 1,
       invalidated_reason = NULL,
       invalidated_at = NULL`,
    [
      fingerprint,
      projectId,
      userId,
      reason,
      dependsOnFiles ? JSON.stringify(dependsOnFiles) : null,
      dependsOnChecksums ? JSON.stringify(dependsOnChecksums) : null,
      reviewByDate || null,
    ],
  );
}

/**
 * Check accepted risks for a project and invalidate any whose
 * dependency files have changed (checksums differ) or whose
 * review_by_date has passed.
 *
 * @returns {{ invalidated: number, reviewDue: number }}
 */
export async function checkAcceptedRiskValidity(pool, projectId, currentFileChecksums) {
  const [risks] = await pool.query(
    `SELECT id, fingerprint, depends_on_files AS dependsOnFiles,
            depends_on_checksums AS dependsOnChecksums,
            review_by_date AS reviewByDate
     FROM accepted_risks
     WHERE project_id = ? AND is_valid = 1`,
    [projectId],
  );

  let invalidated = 0;
  let reviewDue = 0;

  for (const risk of risks) {
    const checksums = typeof risk.dependsOnChecksums === 'string'
      ? JSON.parse(risk.dependsOnChecksums)
      : risk.dependsOnChecksums;
    const depFiles = typeof risk.dependsOnFiles === 'string'
      ? JSON.parse(risk.dependsOnFiles)
      : risk.dependsOnFiles;

    let reason = null;

    // Check if dependency files have changed
    if (checksums && currentFileChecksums && depFiles?.length) {
      for (const file of depFiles) {
        const oldChecksum = checksums[file];
        const newChecksum = currentFileChecksums[file];
        if (oldChecksum && newChecksum && oldChecksum !== newChecksum) {
          reason = `Dependency file "${file}" has been modified since risk was accepted`;
          break;
        }
      }
    }

    // Check if review date has passed
    if (!reason && risk.reviewByDate) {
      const reviewDate = new Date(risk.reviewByDate);
      if (reviewDate <= new Date()) {
        reason = `Review-by date (${risk.reviewByDate}) has passed`;
        reviewDue++;
      }
    }

    if (reason) {
      await pool.execute(
        `UPDATE accepted_risks
         SET is_valid = 0, invalidated_reason = ?, invalidated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [reason, risk.id],
      );
      invalidated++;
    }
  }

  return { invalidated, reviewDue };
}

/**
 * Get all accepted risks for a project.
 */
export async function getAcceptedRisks(pool, projectId) {
  const [rows] = await pool.query(
    `SELECT ar.id, ar.fingerprint, ar.reason,
            ar.depends_on_files AS dependsOnFiles,
            ar.review_by_date AS reviewByDate,
            ar.is_valid AS isValid,
            ar.invalidated_reason AS invalidatedReason,
            ar.invalidated_at AS invalidatedAt,
            ar.created_at AS createdAt,
            ar.accepted_by AS acceptedBy
     FROM accepted_risks ar
     WHERE ar.project_id = ?
     ORDER BY ar.created_at DESC`,
    [projectId],
  );
  return rows.map((r) => ({
    ...r,
    dependsOnFiles: typeof r.dependsOnFiles === 'string' ? JSON.parse(r.dependsOnFiles) : r.dependsOnFiles,
    isValid: Boolean(r.isValid),
  }));
}
