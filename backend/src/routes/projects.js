import { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../auth.js';
import { getPool } from '../config/database.js';
import { env } from '../config/env.js';
import { scanGitHubProject, validateGitHubUrl } from '../services/projectScanner.js';
import { runResolutionJob } from '../services/resolutionAgent.js';

export const projectsRouter = Router();

async function runScanInBackground({ pool, projectId, scanId, githubUrl, openAiApiKey }) {
  try {
    const result = await scanGitHubProject({
      githubUrl,
      openAiApiKey,
      openAiModel: env.openAi.model,
      githubToken: env.github.token,
    });

    // Bulk insert findings in batches to avoid per-row round-trips
    const BATCH_SIZE = 50;
    for (let i = 0; i < result.findings.length; i += BATCH_SIZE) {
      const batch = result.findings.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = batch.flatMap((finding) => [
        uuidv4(),
        scanId,
        projectId,
        finding.severity,
        finding.category,
        finding.description,
        finding.lineNumber,
        finding.weightedScore,
        finding.filePath,
        finding.snippet,
        finding.fingerprint,
      ]);
      await pool.query(
        `INSERT INTO project_findings
          (id, scan_id, project_id, severity, category, description, line_number, weighted_score, file_path, snippet, fingerprint)
         VALUES ${placeholders}`,
        values,
      );
    }

    await pool.execute(
      `UPDATE project_scans
       SET status = 'completed',
           findings_count = ?,
           scanned_files_count = ?,
           security_score = ?,
           summary_json = ?,
           finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        result.summary.totalFindings,
        result.scannedFilesCount,
        result.summary.securityScore,
        JSON.stringify(result.summary),
        scanId,
      ],
    );

    await pool.execute(
      `UPDATE projects
       SET latest_scan_id = ?, security_score = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [scanId, result.summary.securityScore, projectId],
    );

    console.info(
      `[scan] completed project=${projectId} scan=${scanId} findings=${result.summary.totalFindings} score=${result.summary.securityScore}`,
    );
  } catch (e) {
    try {
      await pool.execute(
        `UPDATE project_scans
         SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [String(e?.message || e), scanId],
      );
    } catch {
      // no-op
    }
    console.error(`[scan] failed project=${projectId} scan=${scanId}`, e);
  }
}

async function requireUser(req, res, next) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const userId = session?.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.userId = userId;
    next();
  } catch (e) {
    next(e);
  }
}

projectsRouter.post('/projects', requireUser, async (req, res, next) => {
  try {
    const { githubUrl, description = '' } = req.body ?? {};
    const projectName = req.body?.projectName ?? req.body?.name;
    if (!githubUrl || !projectName) {
      res.status(400).json({ error: 'githubUrl and projectName are required' });
      return;
    }
    if (!validateGitHubUrl(githubUrl)) {
      res.status(400).json({ error: 'Invalid GitHub URL' });
      return;
    }

    const id = uuidv4();
    const pool = getPool();
    await pool.execute(
      `INSERT INTO projects (id, user_id, project_name, github_url, description)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.userId, String(projectName).trim(), String(githubUrl).trim(), String(description)],
    );
    res.status(201).json({
      id,
      projectName: String(projectName).trim(),
      githubUrl: String(githubUrl).trim(),
      description: String(description),
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects', requireUser, async (req, res, next) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT p.id,
              p.project_name AS projectName,
              p.github_url AS githubUrl,
              p.description,
              p.security_score AS securityScore,
              p.latest_scan_id AS latestScanId,
              p.created_at AS createdAt,
              s.status AS latestScanStatus,
              s.findings_count AS latestFindingsCount
       FROM projects p
       LEFT JOIN project_scans s ON s.id = p.latest_scan_id
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC`,
      [req.userId],
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

// --- Lightweight scan status (used for polling instead of the full findings endpoint) ---
projectsRouter.get('/projects/:id/scans/:scanId/status', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, scanId } = req.params;
    const pool = getPool();
    const [[scan]] = await pool.query(
      `SELECT s.status, s.error_message AS errorMessage
       FROM project_scans s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ? AND s.project_id = ? AND p.user_id = ?
       LIMIT 1`,
      [scanId, projectId, req.userId],
    );
    if (!scan) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    res.json(scan);
  } catch (e) {
    next(e);
  }
});

projectsRouter.post('/projects/:id/scan', requireUser, async (req, res, next) => {
  const projectId = req.params.id;
  const scanId = uuidv4();
  const pool = getPool();
  try {
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, github_url AS githubUrl
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (project.userId !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await pool.execute(
      `INSERT INTO project_scans (id, project_id, user_id, status, created_at)
       VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
      [scanId, projectId, req.userId],
    );
    console.info(`[scan] started project=${projectId} scan=${scanId}`);

    const openAiApiKey = req.body?.openAiApiKey || env.openAi.apiKey;
    if (!openAiApiKey) {
      await pool.execute(
        `UPDATE project_scans
         SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        ['Missing OPENAI_API_KEY (or openAiApiKey in request body)', scanId],
      );
      res.status(400).json({ error: 'Missing OpenAI API key' });
      return;
    }

    res.status(202).json({
      scanId,
      status: 'running',
    });

    // Continue scanning after response returns to avoid frontend/proxy timeouts.
    setImmediate(() => {
      runScanInBackground({
        pool,
        projectId,
        scanId,
        githubUrl: project.githubUrl,
        openAiApiKey,
      }).catch((e) => {
        console.error(`[scan] background runner crashed project=${projectId} scan=${scanId}`, e);
      });
    });
  } catch (e) {
    try {
      await pool.execute(
        `UPDATE project_scans
         SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [String(e?.message || e), scanId],
      );
    } catch {
      // no-op
    }
    console.error(`[scan] failed project=${projectId} scan=${scanId}`, e);
    next(e);
  }
});

projectsRouter.get('/projects/:id/findings', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const pool = getPool();

    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, latest_scan_id AS latestScanId
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (project.userId !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const scanId = req.query.scanId ? String(req.query.scanId) : project.latestScanId;
    if (!scanId) {
      res.json({
        data: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 },
        summary: null,
      });
      return;
    }

    // Run scan lookup, count, and paginated findings in parallel
    const [[[scan]], [[countRow]], [rows]] = await Promise.all([
      pool.query(
        `SELECT id, status, findings_count AS findingsCount, scanned_files_count AS scannedFilesCount,
                security_score AS securityScore, summary_json AS summary, created_at AS createdAt, finished_at AS finishedAt
         FROM project_scans
         WHERE id = ? AND project_id = ?
         LIMIT 1`,
        [scanId, projectId],
      ),
      pool.query(
        `SELECT COUNT(*) AS total
         FROM project_findings
         WHERE project_id = ? AND scan_id = ?`,
        [projectId, scanId],
      ),
      pool.query(
        `SELECT id, severity, category, description, line_number AS lineNumber,
                weighted_score AS weightedScore, file_path AS filePath, snippet,
                status, created_at AS createdAt
         FROM project_findings
         WHERE project_id = ? AND scan_id = ?
         ORDER BY weighted_score DESC, created_at DESC
         LIMIT ? OFFSET ?`,
        [projectId, scanId, pageSize, offset],
      ),
    ]);
    const total = Number(countRow?.total || 0);

    res.json({
      data: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      summary: scan
        ? {
            ...scan,
            summary: typeof scan.summary === 'string' ? JSON.parse(scan.summary) : scan.summary,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/:id/audit', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 8));
    const pool = getPool();

    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId
       FROM projects
       WHERE id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (project.userId !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const [scans] = await pool.query(
      `SELECT id,
              status,
              security_score AS securityScore,
              created_at AS createdAt,
              finished_at AS finishedAt,
              user_id AS ranByUserId
       FROM project_scans
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [projectId, limit + 1],
    );

    const entries = scans.slice(0, limit).map((scan, idx) => {
      const prev = scans[idx + 1] || null;
      return { scan, prev };
    });

    // Process all scan pairs in parallel, and run all 6 diff queries per pair in parallel
    const data = await Promise.all(
      entries.map(async ({ scan, prev }) => {
        const ranByUserId = scan?.ranByUserId ?? project.userId ?? null;
        const securityScoreRaw = scan?.securityScore;
        const securityScore = securityScoreRaw == null ? null : Number(securityScoreRaw);

        const prevSecurityScoreRaw = prev?.securityScore;
        const prevSecurityScore = prevSecurityScoreRaw == null ? null : Number(prevSecurityScoreRaw);

        const scoreDelta =
          securityScore == null || prevSecurityScore == null ? null : Math.round(securityScore - prevSecurityScore);

        let diff = null;
        if (prev && scan.status === 'completed' && prev.status === 'completed') {
          const scanId = scan.id;
          const prevScanId = prev.id;

          const [
            [[addedRow]],
            [[removedRow]],
            [[changedRow]],
            [topAdded],
            [topRemoved],
            [topChanged],
          ] = await Promise.all([
            pool.query(
              `SELECT COUNT(DISTINCT cur.fingerprint) AS addedCount
               FROM project_findings cur
               LEFT JOIN project_findings prev
                 ON prev.scan_id = ? AND prev.fingerprint = cur.fingerprint
               WHERE cur.scan_id = ? AND prev.fingerprint IS NULL`,
              [prevScanId, scanId],
            ),
            pool.query(
              `SELECT COUNT(DISTINCT prev.fingerprint) AS removedCount
               FROM project_findings prev
               LEFT JOIN project_findings cur
                 ON cur.scan_id = ? AND cur.fingerprint = prev.fingerprint
               WHERE prev.scan_id = ? AND cur.fingerprint IS NULL`,
              [scanId, prevScanId],
            ),
            pool.query(
              `SELECT COUNT(DISTINCT cur.fingerprint) AS changedCount
               FROM project_findings cur
               JOIN project_findings prev
                 ON prev.scan_id = ? AND prev.fingerprint = cur.fingerprint
               WHERE cur.scan_id = ?
                 AND (
                   cur.severity <> prev.severity
                   OR cur.category <> prev.category
                   OR cur.weighted_score <> prev.weighted_score
                 )`,
              [prevScanId, scanId],
            ),
            pool.query(
              `SELECT cur.fingerprint,
                      cur.severity,
                      cur.category,
                      cur.description,
                      cur.line_number AS lineNumber,
                      cur.weighted_score AS weightedScore,
                      cur.file_path AS filePath
               FROM project_findings cur
               LEFT JOIN project_findings prev
                 ON prev.scan_id = ? AND prev.fingerprint = cur.fingerprint
               WHERE cur.scan_id = ? AND prev.fingerprint IS NULL
               ORDER BY cur.weighted_score DESC, cur.created_at DESC
               LIMIT 3`,
              [prevScanId, scanId],
            ),
            pool.query(
              `SELECT prev.fingerprint,
                      prev.severity,
                      prev.category,
                      prev.description,
                      prev.line_number AS lineNumber,
                      prev.weighted_score AS weightedScore,
                      prev.file_path AS filePath
               FROM project_findings prev
               LEFT JOIN project_findings cur
                 ON cur.scan_id = ? AND cur.fingerprint = prev.fingerprint
               WHERE prev.scan_id = ? AND cur.fingerprint IS NULL
               ORDER BY prev.weighted_score DESC, prev.created_at DESC
               LIMIT 3`,
              [scanId, prevScanId],
            ),
            pool.query(
              `SELECT cur.fingerprint,
                      cur.severity,
                      cur.category,
                      cur.description,
                      cur.line_number AS lineNumber,
                      cur.weighted_score AS weightedScore,
                      cur.file_path AS filePath
               FROM project_findings cur
               JOIN project_findings prev
                 ON prev.scan_id = ? AND prev.fingerprint = cur.fingerprint
               WHERE cur.scan_id = ?
                 AND (
                   cur.severity <> prev.severity
                   OR cur.category <> prev.category
                   OR cur.weighted_score <> prev.weighted_score
                 )
               ORDER BY cur.weighted_score DESC, cur.created_at DESC
               LIMIT 3`,
              [prevScanId, scanId],
            ),
          ]);

          diff = {
            addedCount: Number(addedRow?.addedCount || 0),
            removedCount: Number(removedRow?.removedCount || 0),
            changedCount: Number(changedRow?.changedCount || 0),
            topAdded,
            topRemoved,
            topChanged,
          };
        }

        return {
          scanId: scan.id,
          status: scan.status,
          createdAt: scan.createdAt,
          finishedAt: scan.finishedAt,
          ranByUserId,
          securityScore,
          scoreDelta,
          diff,
        };
      }),
    );

    res.json({ data });
  } catch (e) {
    next(e);
  }
});

// --- Finding status toggle ---
projectsRouter.patch('/projects/:id/findings/:findingId/status', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const { status } = req.body ?? {};
    const validStatuses = ['open', 'in_progress', 'resolved'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [result] = await pool.execute(
      `UPDATE project_findings SET status = ? WHERE id = ? AND project_id = ?`,
      [status, findingId, projectId],
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    res.json({ ok: true, findingId, status });
  } catch (e) {
    next(e);
  }
});

// --- Resolve single finding ---
projectsRouter.post('/projects/:id/findings/:findingId/resolve', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const githubToken = env.github.token;
    if (!githubToken) {
      res.status(500).json({ error: 'GITHUB_TOKEN not configured on server' });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, github_url AS githubUrl FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id FROM project_findings WHERE id = ? AND project_id = ? LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    const openAiApiKey = req.body?.openAiApiKey || env.openAi.apiKey;
    if (!openAiApiKey) {
      res.status(400).json({ error: 'Missing OpenAI API key' });
      return;
    }

    const jobId = uuidv4();
    const findingIds = [findingId];
    await pool.execute(
      `INSERT INTO resolution_jobs (id, project_id, user_id, status, finding_ids)
       VALUES (?, ?, ?, 'pending', ?)`,
      [jobId, projectId, req.userId, JSON.stringify(findingIds)],
    );

    res.status(202).json({ jobId, status: 'pending' });

    setImmediate(() => {
      runResolutionJob({
        jobId,
        projectId,
        findingIds,
        githubUrl: project.githubUrl,
        githubToken,
        openAiApiKey,
      }).catch((e) => {
        console.error(`[resolve] background runner crashed job=${jobId}`, e);
      });
    });
  } catch (e) {
    next(e);
  }
});

// --- Resolve all open findings ---
projectsRouter.post('/projects/:id/resolve-all', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const githubToken = env.github.token;
    if (!githubToken) {
      res.status(500).json({ error: 'GITHUB_TOKEN not configured on server' });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, github_url AS githubUrl, latest_scan_id AS latestScanId
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!project.latestScanId) {
      res.status(400).json({ error: 'No scan results to resolve' });
      return;
    }

    const openAiApiKey = req.body?.openAiApiKey || env.openAi.apiKey;
    if (!openAiApiKey) {
      res.status(400).json({ error: 'Missing OpenAI API key' });
      return;
    }

    const [openFindings] = await pool.query(
      `SELECT id FROM project_findings
       WHERE project_id = ? AND scan_id = ? AND status = 'open'
       ORDER BY weighted_score DESC`,
      [projectId, project.latestScanId],
    );

    if (openFindings.length === 0) {
      res.status(400).json({ error: 'No open findings to resolve' });
      return;
    }

    const findingIds = openFindings.map((f) => f.id);
    const jobId = uuidv4();
    await pool.execute(
      `INSERT INTO resolution_jobs (id, project_id, user_id, status, finding_ids)
       VALUES (?, ?, ?, 'pending', ?)`,
      [jobId, projectId, req.userId, JSON.stringify(findingIds)],
    );

    res.status(202).json({ jobId, status: 'pending', findingsCount: findingIds.length });

    setImmediate(() => {
      runResolutionJob({
        jobId,
        projectId,
        findingIds,
        githubUrl: project.githubUrl,
        githubToken,
        openAiApiKey,
      }).catch((e) => {
        console.error(`[resolve] background runner crashed job=${jobId}`, e);
      });
    });
  } catch (e) {
    next(e);
  }
});

// --- Poll resolution job status ---
projectsRouter.get('/projects/:id/resolution-jobs/:jobId', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, jobId } = req.params;
    const pool = getPool();

    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[job]] = await pool.query(
      `SELECT id, status, pr_url AS prUrl, branch_name AS branchName,
              error_message AS errorMessage, finding_ids AS findingIds,
              created_at AS createdAt, updated_at AS updatedAt
       FROM resolution_jobs
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [jobId, projectId],
    );
    if (!job) { res.status(404).json({ error: 'Resolution job not found' }); return; }

    res.json({
      ...job,
      findingIds: typeof job.findingIds === 'string' ? JSON.parse(job.findingIds) : job.findingIds,
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.delete('/projects/:id', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();

    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId
       FROM projects
       WHERE id = ?
       LIMIT 1`,
      [projectId],
    );
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (project.userId !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await pool.execute(`DELETE FROM projects WHERE id = ?`, [projectId]);
    res.json({ ok: true, id: projectId });
  } catch (e) {
    next(e);
  }
});

