import { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../auth.js';
import { getPool } from '../config/database.js';
import { env } from '../config/env.js';
import { scanGitHubProject, validateGitHubUrl } from '../services/projectScanner.js';

export const projectsRouter = Router();

async function runScanInBackground({ pool, projectId, scanId, githubUrl, openAiApiKey }) {
  try {
    const result = await scanGitHubProject({
      githubUrl,
      openAiApiKey,
      openAiModel: env.openAi.model,
      githubToken: env.github.token,
    });

    for (const finding of result.findings) {
      await pool.execute(
        `INSERT INTO project_findings
          (id, scan_id, project_id, severity, category, description, line_number, weighted_score, file_path, snippet, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        ],
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
      `INSERT INTO project_scans (id, project_id, status, created_at)
       VALUES (?, ?, 'running', CURRENT_TIMESTAMP)`,
      [scanId, projectId],
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

    const [[scan]] = await pool.query(
      `SELECT id, status, findings_count AS findingsCount, scanned_files_count AS scannedFilesCount,
              security_score AS securityScore, summary_json AS summary, created_at AS createdAt, finished_at AS finishedAt
       FROM project_scans
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [scanId, projectId],
    );

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM project_findings
       WHERE project_id = ? AND scan_id = ?`,
      [projectId, scanId],
    );
    const total = Number(countRow?.total || 0);

    const [rows] = await pool.query(
      `SELECT id, severity, category, description, line_number AS lineNumber,
              weighted_score AS weightedScore, file_path AS filePath, snippet, created_at AS createdAt
       FROM project_findings
       WHERE project_id = ? AND scan_id = ?
       ORDER BY weighted_score DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      [projectId, scanId, pageSize, offset],
    );

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

