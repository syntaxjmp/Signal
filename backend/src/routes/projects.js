import { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../auth.js';
import { getPool } from '../config/database.js';
import { env } from '../config/env.js';
import { scanGitHubProject, validateGitHubUrl } from '../services/projectScanner.js';
import { runResolutionJob } from '../services/resolutionAgent.js';
import {
  clearUserWebhook,
  getUserWebhook,
  isValidDiscordWebhookUrl,
  sendWebhookForUser,
  setUserWebhook,
} from '../services/webhookHandler.js';
import {
  buildComplianceReportPayload,
  complianceReportPdfFilename,
  pipeComplianceReportPdf,
} from '../services/complianceReport.js';
import { normalizeFrameworkIds } from '../services/complianceFrameworks.js';
import {
  buildScanMemoryContext,
  detectAndStoreRegressions,
  recomputeScanBaseline,
  acceptRisk,
  getAcceptedRisks,
  checkAcceptedRiskValidity,
} from '../services/statefulMemory.js';
import {
  searchSimilarDismissedFindings,
  searchSimilarFixes,
  searchSimilarVulnerablePatterns,
  upsertFindingEmbeddings,
  upsertCodePatternEmbeddings,
  isVectorEnabled,
} from '../services/vectorStore.js';
import axios from 'axios';
import { reduceToPCA2D } from '../services/vectorReducer.js';
import { createFixOutcome } from '../services/fixOutcomeTracker.js';
import { buildDeveloperProfiles } from '../services/developerProfiler.js';
import { analyzeAttackChains } from '../services/attackChainDetector.js';

export const projectsRouter = Router();

function repoPathFromUrl(githubUrl) {
  try {
    const u = new URL(githubUrl);
    return u.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  } catch {
    return githubUrl;
  }
}

/** Better Auth `user` row → display string for audit "Ran by" */
function displayNameFromUserRow(row) {
  if (!row) return null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name) return name;
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  if (email) {
    const local = email.split('@')[0];
    if (local) return local;
  }
  return null;
}

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

    if (Array.isArray(result.codeElements) && result.codeElements.length > 0) {
      for (let i = 0; i < result.codeElements.length; i += BATCH_SIZE) {
        const batch = result.codeElements.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '(UUID(), ?, ?, ?, ?, ?, ?, NULL, ?)').join(', ');
        const values = batch.flatMap((el) => [
          projectId,
          scanId,
          el.elementType,
          el.filePath,
          el.lineStart ?? null,
          el.identifier ?? null,
          JSON.stringify(el.metadata || {}),
        ]);
        await pool.query(
          `INSERT INTO code_elements
            (id, project_id, scan_id, element_type, file_path, line_start, identifier, parent_element_id, metadata)
           VALUES ${placeholders}`,
          values,
        );
      }
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

    // Stateful memory hooks: regression + baseline + developer profiles + accepted risk checks.
    try {
      await detectAndStoreRegressions(pool, projectId, scanId);
      await recomputeScanBaseline(pool, projectId);
    } catch (memoryErr) {
      console.warn(
        `[memory] non-fatal stateful update failed project=${projectId} scan=${scanId}`,
        memoryErr instanceof Error ? memoryErr.message : String(memoryErr),
      );
    }

    // Developer profiles: attribute findings to authors via git blame
    try {
      const profileResult = await buildDeveloperProfiles(pool, projectId, scanId, githubUrl);
      if (profileResult.profilesUpdated > 0) {
        console.info(
          `[dev-profiler] project=${projectId} scan=${scanId} profiles=${profileResult.profilesUpdated} links=${profileResult.linksCreated}`,
        );
      }
    } catch (profilerErr) {
      console.warn(
        `[dev-profiler] non-fatal profiler update failed project=${projectId} scan=${scanId}`,
        profilerErr instanceof Error ? profilerErr.message : String(profilerErr),
      );
    }

    // Check accepted risks for invalidation (file dependency changes)
    try {
      const riskResult = await checkAcceptedRiskValidity(pool, projectId, null);
      if (riskResult.invalidated > 0) {
        console.info(
          `[accepted-risks] project=${projectId} invalidated=${riskResult.invalidated} reviewDue=${riskResult.reviewDue}`,
        );
      }
    } catch (riskErr) {
      console.warn(
        `[accepted-risks] non-fatal risk check failed project=${projectId}`,
        riskErr instanceof Error ? riskErr.message : String(riskErr),
      );
    }

    try {
      const [findingRows] = await pool.query(
        `SELECT id, fingerprint, severity, category, description, file_path AS filePath, snippet, status,
                line_number AS lineNumber
         FROM project_findings
         WHERE project_id = ? AND scan_id = ?
         ORDER BY weighted_score DESC
         LIMIT 300`,
        [projectId, scanId],
      );
      await upsertFindingEmbeddings({
        findings: findingRows,
        projectId,
        scanId,
      });

      // Phase 2: Embed code patterns from findings for vulnerability pattern recognition
      await upsertCodePatternEmbeddings({
        findings: findingRows,
        projectId,
        scanId,
      });
    } catch (vectorErr) {
      console.warn(
        `[vector] non-fatal embedding upsert failed project=${projectId} scan=${scanId}`,
        vectorErr instanceof Error ? vectorErr.message : String(vectorErr),
      );
    }

    // Phase 3b/3c: Attack chain detection and combined finding analysis
    try {
      const chainResult = await analyzeAttackChains(pool, projectId, scanId, openAiApiKey, env.openAi.model);
      if (chainResult.chainsDetected > 0) {
        console.info(
          `[attack-chains] project=${projectId} scan=${scanId} chains=${chainResult.chainsDetected} narratives=${chainResult.narrativesGenerated} relationships=${chainResult.relationshipsBuilt} links=${chainResult.linksCreated}`,
        );
      }
    } catch (chainErr) {
      console.warn(
        `[attack-chains] non-fatal analysis failed project=${projectId} scan=${scanId}`,
        chainErr instanceof Error ? chainErr.message : String(chainErr),
      );
    }

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

/**
 * Create a running scan row, point project at it, and enqueue background work.
 * @returns {{ ok: true, scanId: string, status: string } | { ok: false, scanId: string, error: string, httpStatus: number }}
 */
async function beginProjectScan(pool, { projectId, userId, githubUrl, notifyUserId, openAiApiKey }) {
  const scanId = uuidv4();
  const key = openAiApiKey || env.openAi.apiKey;

  await pool.execute(
    `INSERT INTO project_scans (id, project_id, user_id, status, created_at)
     VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
    [scanId, projectId, userId],
  );

  await pool.execute(
    `UPDATE projects SET latest_scan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [scanId, projectId],
  );

  if (!key) {
    await pool.execute(
      `UPDATE project_scans
       SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['Missing OPENAI_API_KEY (or openAiApiKey in request body)', scanId],
    );
    return {
      ok: false,
      scanId,
      error: 'Missing OpenAI API key',
      httpStatus: 400,
    };
  }

  console.info(`[scan] started project=${projectId} scan=${scanId}`);

  if (notifyUserId) {
    void sendWebhookForUser(notifyUserId, {
      title: 'New Scan Started',
      description: 'Signal started scanning your repository.',
      fields: [
        { name: 'Project ID', value: projectId, inline: true },
        { name: 'Scan ID', value: scanId, inline: true },
        { name: 'Repository', value: repoPathFromUrl(githubUrl), inline: false },
      ],
    });
  }

  setImmediate(() => {
    runScanInBackground({
      pool,
      projectId,
      scanId,
      githubUrl,
      openAiApiKey: key,
    }).catch((e) => {
      console.error(`[scan] background runner crashed project=${projectId} scan=${scanId}`, e);
    });
  });

  return { ok: true, scanId, status: 'running', httpStatus: 202 };
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
    const scanOnCreate = req.body?.scanOnCreate !== false;
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
    const urlTrimmed = String(githubUrl).trim();
    await pool.execute(
      `INSERT INTO projects (id, user_id, project_name, github_url, description)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.userId, String(projectName).trim(), urlTrimmed, String(description)],
    );

    let initialScan = { skipped: true };
    if (scanOnCreate) {
      const scanResult = await beginProjectScan(pool, {
        projectId: id,
        userId: req.userId,
        githubUrl: urlTrimmed,
        notifyUserId: req.userId,
        openAiApiKey: env.openAi.apiKey,
      });
      if (scanResult.ok) {
        initialScan = { scanId: scanResult.scanId, status: scanResult.status };
      } else {
        initialScan = {
          scanId: scanResult.scanId,
          status: 'failed',
          error: scanResult.error,
        };
      }
    }

    res.status(201).json({
      id,
      projectName: String(projectName).trim(),
      githubUrl: urlTrimmed,
      description: String(description),
      initialScan,
    });

    void sendWebhookForUser(req.userId, {
      title: 'New Codebase Added',
      description: `A new project was added to Signal.`,
      fields: [
        { name: 'Project', value: String(projectName).trim(), inline: true },
        { name: 'Repository', value: repoPathFromUrl(urlTrimmed), inline: true },
        ...(scanOnCreate && initialScan.scanId
          ? [{ name: 'Scan', value: initialScan.status === 'failed' ? 'Failed to start (check API key)' : 'Started', inline: true }]
          : []),
      ],
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/webhook', requireUser, async (req, res, next) => {
  try {
    const hook = await getUserWebhook(req.userId);
    res.json({
      enabled: !!hook?.isActive,
      webhookUrl: hook?.isActive ? hook.webhookUrl : '',
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.put('/projects/webhook', requireUser, async (req, res, next) => {
  try {
    const webhookUrl = String(req.body?.webhookUrl || '').trim();
    if (!isValidDiscordWebhookUrl(webhookUrl)) {
      res.status(400).json({ error: 'Please provide a valid Discord webhook URL.' });
      return;
    }
    await setUserWebhook({ userId: req.userId, webhookUrl });
    res.json({ ok: true, enabled: true, webhookUrl });

    void sendWebhookForUser(req.userId, {
      title: 'Webhook Connected',
      description: 'Signal notifications are now enabled for this Discord channel.',
      fields: [{ name: 'Status', value: 'Connected', inline: true }],
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.delete('/projects/webhook', requireUser, async (req, res, next) => {
  try {
    await clearUserWebhook(req.userId);
    res.json({ ok: true, enabled: false });
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
  const pool = getPool();
  let scanIdForError = null;
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

    const openAiApiKey = req.body?.openAiApiKey || env.openAi.apiKey;
    const result = await beginProjectScan(pool, {
      projectId,
      userId: req.userId,
      githubUrl: project.githubUrl,
      notifyUserId: req.userId,
      openAiApiKey,
    });
    scanIdForError = result.scanId;

    if (!result.ok) {
      res.status(result.httpStatus).json({ error: result.error });
      return;
    }

    res.status(202).json({
      scanId: result.scanId,
      status: result.status,
    });
  } catch (e) {
    if (scanIdForError) {
      try {
        await pool.execute(
          `UPDATE project_scans
           SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [String(e?.message || e), scanIdForError],
        );
      } catch {
        // no-op
      }
    }
    console.error(`[scan] failed project=${projectId} scan=${scanIdForError}`, e);
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

    let prUrl = null;
    let prJobId = null;
    let prBranchName = null;
    if (scan) {
      const [[nextScan]] = await pool.query(
        `SELECT created_at AS createdAt
         FROM project_scans
         WHERE project_id = ?
           AND created_at > ?
         ORDER BY created_at ASC
         LIMIT 1`,
        [projectId, scan.createdAt],
      );

      const [prRows] = nextScan?.createdAt
        ? await pool.query(
            `SELECT id, pr_url AS prUrl, branch_name AS branchName
             FROM resolution_jobs
             WHERE project_id = ?
               AND status = 'completed'
               AND pr_url IS NOT NULL
               AND created_at >= ?
               AND created_at < ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [projectId, scan.createdAt, nextScan.createdAt],
          )
        : await pool.query(
            `SELECT id, pr_url AS prUrl, branch_name AS branchName
             FROM resolution_jobs
             WHERE project_id = ?
               AND status = 'completed'
               AND pr_url IS NOT NULL
               AND created_at >= ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [projectId, scan.createdAt],
          );

      const latestPr = prRows?.[0];
      prUrl = latestPr?.prUrl ?? null;
      prJobId = latestPr?.id ?? null;
      prBranchName = latestPr?.branchName ?? null;
    }

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
            prUrl,
            prJobId,
            prBranchName,
            summary: typeof scan.summary === 'string' ? JSON.parse(scan.summary) : scan.summary,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

function complianceFrameworkIdsFromQuery(req) {
  const q = req.query.frameworks;
  if (q == null || q === '') return undefined;
  const ids = String(q)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? normalizeFrameworkIds(ids) : undefined;
}

projectsRouter.get('/projects/:id/compliance-report/export', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const frameworkIds = complianceFrameworkIdsFromQuery(req);
    const payload = await buildComplianceReportPayload(pool, projectId, req.userId, { frameworkIds });
    if (payload.error === 'not_found') {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (payload.error === 'forbidden') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const filename = complianceReportPdfFilename(payload.project?.projectName);
    await pipeComplianceReportPdf(payload, res, filename);
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/:id/compliance-report', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const frameworkIds = complianceFrameworkIdsFromQuery(req);
    const payload = await buildComplianceReportPayload(pool, projectId, req.userId, { frameworkIds });
    if (payload.error === 'not_found') {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (payload.error === 'forbidden') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

projectsRouter.patch('/projects/:id/compliance-frameworks', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
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
    if (!Array.isArray(req.body?.frameworkIds)) {
      res.status(400).json({ error: 'frameworkIds must be an array (use [] for none)' });
      return;
    }
    const normalized = normalizeFrameworkIds(req.body.frameworkIds);
    await pool.query(`UPDATE projects SET compliance_frameworks = ? WHERE id = ?`, [
      JSON.stringify(normalized),
      projectId,
    ]);
    res.json({ ok: true, frameworkIds: normalized });
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

    const userIds = new Set();
    for (const s of scans) {
      if (s.ranByUserId) userIds.add(String(s.ranByUserId));
    }
    if (project.userId) userIds.add(String(project.userId));

    const userDisplayById = new Map();
    const idList = [...userIds].filter(Boolean);
    if (idList.length) {
      const placeholders = idList.map(() => '?').join(',');
      try {
        const [userRows] = await pool.query(
          `SELECT id, name, email FROM \`user\` WHERE id IN (${placeholders})`,
          idList,
        );
        for (const row of userRows) {
          const id = String(row.id);
          const dn = displayNameFromUserRow(row);
          userDisplayById.set(id, dn ?? `User ${id.slice(0, 8)}`);
        }
      } catch (e) {
        console.warn('[audit] Could not load user names:', e?.message || e);
      }
    }

    function ranByDisplayNameFor(ranByUserId) {
      if (!ranByUserId) return 'Unknown';
      const key = String(ranByUserId);
      if (userDisplayById.has(key)) return userDisplayById.get(key);
      return `User ${key.slice(0, 8)}`;
    }

    const entries = scans.slice(0, limit).map((scan, idx) => {
      const prev = scans[idx + 1] || null; // older scan
      const next = idx > 0 ? scans[idx - 1] : null; // newer scan
      return { scan, prev, next };
    });

    // Process all scan pairs in parallel, and run all 6 diff queries per pair in parallel
    const data = await Promise.all(
      entries.map(async ({ scan, prev, next }) => {
        const ranByUserId = scan?.ranByUserId ?? project.userId ?? null;
        const securityScoreRaw = scan?.securityScore;
        const securityScore = securityScoreRaw == null ? null : Number(securityScoreRaw);

        const prevSecurityScoreRaw = prev?.securityScore;
        const prevSecurityScore = prevSecurityScoreRaw == null ? null : Number(prevSecurityScoreRaw);

        const scoreDelta =
          securityScore == null || prevSecurityScore == null ? null : Math.round(securityScore - prevSecurityScore);

        let diff = null;
        // Attach PRs created after this scan started, until the next newer scan starts.
        const scanWindowStart = scan.createdAt;
        const scanWindowEnd = next?.createdAt ?? null;
        const [prRows] = scanWindowEnd
          ? await pool.query(
              `SELECT id, pr_url AS prUrl, branch_name AS branchName, created_at AS createdAt
               FROM resolution_jobs
               WHERE project_id = ?
                 AND status = 'completed'
                 AND pr_url IS NOT NULL
                 AND created_at >= ?
                 AND created_at < ?
               ORDER BY created_at DESC
               LIMIT 1`,
              [projectId, scanWindowStart, scanWindowEnd],
            )
          : await pool.query(
              `SELECT id, pr_url AS prUrl, branch_name AS branchName, created_at AS createdAt
               FROM resolution_jobs
               WHERE project_id = ?
                 AND status = 'completed'
                 AND pr_url IS NOT NULL
                 AND created_at >= ?
               ORDER BY created_at DESC
               LIMIT 1`,
              [projectId, scanWindowStart],
            );
        const latestPrJob = prRows?.[0] ?? null;

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
          ranByDisplayName: ranByDisplayNameFor(ranByUserId),
          securityScore,
          scoreDelta,
          prUrl: latestPrJob?.prUrl ?? null,
          prJobId: latestPrJob?.id ?? null,
          prBranchName: latestPrJob?.branchName ?? null,
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

// --- Dismiss finding (stateful memory seed) ---
projectsRouter.post('/projects/:id/findings/:findingId/dismiss', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const reasonCode = String(req.body?.reasonCode || '').trim();
    const justification = String(req.body?.justification || '').trim();
    const scope = String(req.body?.scope || 'finding').trim();
    const validReasons = ['false_positive', 'accepted_risk', 'mitigated_elsewhere', 'test_code', 'wont_fix'];
    const validScopes = ['finding', 'project', 'org'];

    if (!validReasons.includes(reasonCode)) {
      res.status(400).json({ error: `reasonCode must be one of: ${validReasons.join(', ')}` });
      return;
    }
    if (!validScopes.includes(scope)) {
      res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id, fingerprint, severity, category, description, file_path AS filePath, snippet, status
       FROM project_findings
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    await pool.execute(
      `INSERT INTO finding_dismissals
        (id, fingerprint, project_id, user_id, reason_code, justification, scope, is_active)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, 1) AS new_row
       ON DUPLICATE KEY UPDATE
        user_id = new_row.user_id,
        reason_code = new_row.reason_code,
        justification = new_row.justification,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [finding.fingerprint, projectId, req.userId, reasonCode, justification || null, scope],
    );

    try {
      await upsertFindingEmbeddings({
        findings: [finding],
        projectId,
        scanId: 'dismissal',
        markDismissed: true,
        dismissReason: reasonCode,
      });
    } catch (vectorErr) {
      console.warn('[vector] dismissal embedding update failed', vectorErr instanceof Error ? vectorErr.message : String(vectorErr));
    }

    res.json({
      ok: true,
      findingId,
      fingerprint: finding.fingerprint,
      reasonCode,
      scope,
    });
  } catch (e) {
    next(e);
  }
});

// --- Lightweight memory context for latest / selected scan ---
projectsRouter.get('/projects/:id/memory-context', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, latest_scan_id AS latestScanId
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const scanId = req.query.scanId ? String(req.query.scanId) : project.latestScanId;
    if (!scanId) {
      res.json({
        scanId: null,
        memory: {
          dismissalMatches: 0,
          regressionsDetected: 0,
          baseline: null,
        },
      });
      return;
    }

    const memory = await buildScanMemoryContext(pool, projectId, scanId);
    res.json({ scanId, memory });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/:id/findings/:findingId/similar-dismissed', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id, severity, category, description, file_path AS filePath, snippet, fingerprint, status
       FROM project_findings
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    const similar = await searchSimilarDismissedFindings({
      projectId,
      finding,
      limit: Math.min(10, Math.max(1, Number(req.query.limit) || 5)),
      scoreThreshold: Math.max(0.7, Math.min(0.99, Number(req.query.threshold) || 0.92)),
    });
    res.json({ findingId, similar });
  } catch (e) {
    next(e);
  }
});

// --- Similar past fixes for a finding (Phase 2d) ---
projectsRouter.get('/projects/:id/findings/:findingId/similar-fixes', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id, severity, category, description, file_path AS filePath, snippet
       FROM project_findings
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    const similar = await searchSimilarFixes({
      finding,
      limit: Math.min(10, Math.max(1, Number(req.query.limit) || 3)),
      scoreThreshold: Math.max(0.5, Math.min(0.99, Number(req.query.threshold) || 0.80)),
    });
    res.json({ findingId, similarFixes: similar });
  } catch (e) {
    next(e);
  }
});

// --- Similar vulnerable code patterns for a finding (Phase 2) ---
projectsRouter.get('/projects/:id/findings/:findingId/similar-patterns', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id, snippet, file_path AS filePath
       FROM project_findings
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    const similar = await searchSimilarVulnerablePatterns({
      snippet: finding.snippet,
      filePath: finding.filePath,
      limit: Math.min(10, Math.max(1, Number(req.query.limit) || 5)),
      scoreThreshold: Math.max(0.5, Math.min(0.99, Number(req.query.threshold) || 0.88)),
    });
    res.json({ findingId, similarPatterns: similar });
  } catch (e) {
    next(e);
  }
});

projectsRouter.post('/projects/:id/policies/sla', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const severity = String(req.body?.severity || '').toLowerCase();
    const maxAgeHours = Number(req.body?.maxAgeHours || 0);
    const name = String(req.body?.name || `SLA ${severity} ${maxAgeHours}h`).trim();
    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (!validSeverities.includes(severity)) {
      res.status(400).json({ error: `severity must be one of: ${validSeverities.join(', ')}` });
      return;
    }
    if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
      res.status(400).json({ error: 'maxAgeHours must be a positive number' });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const policyId = uuidv4();
    await pool.execute(
      `INSERT INTO security_policies
        (id, project_id, name, rule_type, condition_json, action_json, is_active, created_by)
       VALUES (?, ?, ?, 'sla', ?, ?, 1, ?)`,
      [
        policyId,
        projectId,
        name,
        JSON.stringify({ severity, maxAgeHours }),
        JSON.stringify({ notify: 'none' }),
        req.userId,
      ],
    );

    res.status(201).json({
      id: policyId,
      projectId,
      name,
      ruleType: 'sla',
      condition: { severity, maxAgeHours },
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/:id/sla-violations', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [rows] = await pool.query(
      `SELECT v.id,
              v.status,
              v.severity,
              v.due_hours AS dueHours,
              v.created_at AS createdAt,
              p.name AS policyName,
              f.id AS findingId,
              f.category,
              f.description,
              f.file_path AS filePath,
              f.line_number AS lineNumber
       FROM sla_violations v
       JOIN security_policies p ON p.id = v.policy_id
       JOIN project_findings f ON f.id = v.finding_id
       WHERE v.project_id = ?
       ORDER BY v.created_at DESC
       LIMIT ?`,
      [projectId, Math.min(200, Math.max(1, Number(req.query.limit) || 50))],
    );
    res.json({ data: rows });
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

    void sendWebhookForUser(req.userId, {
      title: 'Resolve Job Started',
      description: 'Signal Bot started resolving a finding.',
      fields: [
        { name: 'Project ID', value: projectId, inline: true },
        { name: 'Finding ID', value: findingId, inline: true },
        { name: 'Job ID', value: jobId, inline: true },
      ],
    });

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

    void sendWebhookForUser(req.userId, {
      title: 'Resolve-All Started',
      description: 'Signal Bot started resolving open findings.',
      fields: [
        { name: 'Project ID', value: projectId, inline: true },
        { name: 'Job ID', value: jobId, inline: true },
        { name: 'Findings', value: String(findingIds.length), inline: true },
      ],
    });

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

// --- Fix Outcome Stats ---
projectsRouter.get('/projects/:id/fix-outcomes', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[stats]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(pr_status = 'merged') AS merged,
         SUM(pr_status = 'closed') AS closed,
         SUM(pr_status = 'open') AS open
       FROM fix_outcomes
       WHERE project_id = ?`,
      [projectId],
    );

    const [outcomes] = await pool.query(
      `SELECT fo.id, fo.pr_url AS prUrl, fo.pr_status AS prStatus,
              fo.fix_category AS fixCategory, fo.files_changed AS filesChanged,
              fo.review_comments_count AS reviewCommentsCount,
              fo.merged_at AS mergedAt, fo.closed_at AS closedAt,
              fo.created_at AS createdAt
       FROM fix_outcomes fo
       WHERE fo.project_id = ?
       ORDER BY fo.created_at DESC
       LIMIT ?`,
      [projectId, Math.min(100, Math.max(1, Number(req.query.limit) || 20))],
    );

    const total = Number(stats?.total || 0);
    const mergedCount = Number(stats?.merged || 0);
    res.json({
      stats: {
        total,
        merged: mergedCount,
        closed: Number(stats?.closed || 0),
        open: Number(stats?.open || 0),
        mergeRate: total > 0 ? Math.round((mergedCount / total) * 100) : null,
      },
      data: outcomes,
    });
  } catch (e) {
    next(e);
  }
});

// --- Developer Profiles ---
projectsRouter.get('/projects/:id/developer-profiles', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [profiles] = await pool.query(
      `SELECT id, author_email AS authorEmail, author_name AS authorName,
              total_findings_introduced AS totalFindings,
              critical_count AS criticalCount, high_count AS highCount,
              medium_count AS mediumCount, low_count AS lowCount,
              top_categories AS topCategories,
              avg_fix_time_hours AS avgFixTimeHours,
              risk_score AS riskScore,
              first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
       FROM developer_profiles
       WHERE project_id = ?
       ORDER BY risk_score DESC
       LIMIT ?`,
      [projectId, Math.min(100, Math.max(1, Number(req.query.limit) || 20))],
    );

    res.json({
      data: profiles.map((p) => ({
        ...p,
        topCategories: typeof p.topCategories === 'string' ? JSON.parse(p.topCategories) : p.topCategories,
        riskScore: Number(p.riskScore),
      })),
    });
  } catch (e) {
    next(e);
  }
});

// --- Accept Risk on a Finding ---
projectsRouter.post('/projects/:id/findings/:findingId/accept-risk', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, findingId } = req.params;
    const reason = String(req.body?.reason || '').trim();
    const dependsOnFiles = req.body?.dependsOnFiles || null;
    const dependsOnChecksums = req.body?.dependsOnChecksums || null;
    const reviewByDate = req.body?.reviewByDate || null;

    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    if (dependsOnFiles && !Array.isArray(dependsOnFiles)) {
      res.status(400).json({ error: 'dependsOnFiles must be an array of file paths' });
      return;
    }

    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[finding]] = await pool.query(
      `SELECT id, fingerprint FROM project_findings WHERE id = ? AND project_id = ? LIMIT 1`,
      [findingId, projectId],
    );
    if (!finding) { res.status(404).json({ error: 'Finding not found' }); return; }

    await acceptRisk(pool, {
      fingerprint: finding.fingerprint,
      projectId,
      userId: req.userId,
      reason,
      dependsOnFiles,
      dependsOnChecksums,
      reviewByDate,
    });

    res.json({
      ok: true,
      findingId,
      fingerprint: finding.fingerprint,
      reason,
      dependsOnFiles,
      reviewByDate,
    });
  } catch (e) {
    next(e);
  }
});

// --- List Accepted Risks ---
projectsRouter.get('/projects/:id/accepted-risks', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const risks = await getAcceptedRisks(pool, projectId);
    res.json({ data: risks });
  } catch (e) {
    next(e);
  }
});

// --- Attack Chains ---
projectsRouter.get('/projects/:id/attack-chains', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, latest_scan_id AS latestScanId
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const scanId = req.query.scanId ? String(req.query.scanId) : project.latestScanId;
    if (!scanId) {
      res.json({ data: [], summary: { total: 0, bySeverity: {}, byType: {} } });
      return;
    }

    const [chains] = await pool.query(
      `SELECT ac.id, ac.chain_type AS chainType, ac.severity,
              ac.escalated_from AS escalatedFrom, ac.narrative,
              ac.hop_count AS hopCount, ac.element_ids AS elementIds,
              ac.finding_ids AS findingIds, ac.metadata,
              ac.entry_element_id AS entryElementId,
              ac.created_at AS createdAt,
              ce.identifier AS entryIdentifier, ce.file_path AS entryFilePath
       FROM attack_chains ac
       LEFT JOIN code_elements ce ON ce.id = ac.entry_element_id
       WHERE ac.project_id = ? AND ac.scan_id = ?
       ORDER BY FIELD(ac.severity, 'critical', 'high', 'medium', 'low'), ac.created_at DESC`,
      [projectId, scanId],
    );

    // Build summary counts
    const bySeverity = {};
    const byType = {};
    for (const c of chains) {
      bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
      byType[c.chainType] = (byType[c.chainType] || 0) + 1;
    }

    res.json({
      data: chains.map((c) => ({
        ...c,
        elementIds: typeof c.elementIds === 'string' ? JSON.parse(c.elementIds) : c.elementIds,
        findingIds: typeof c.findingIds === 'string' ? JSON.parse(c.findingIds) : c.findingIds,
        metadata: typeof c.metadata === 'string' ? JSON.parse(c.metadata) : c.metadata,
      })),
      summary: { total: chains.length, bySeverity, byType },
    });
  } catch (e) {
    next(e);
  }
});

projectsRouter.get('/projects/:id/attack-chains/:chainId', requireUser, async (req, res, next) => {
  try {
    const { id: projectId, chainId } = req.params;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const [[chain]] = await pool.query(
      `SELECT ac.id, ac.chain_type AS chainType, ac.severity,
              ac.escalated_from AS escalatedFrom, ac.narrative,
              ac.hop_count AS hopCount, ac.element_ids AS elementIds,
              ac.finding_ids AS findingIds, ac.metadata,
              ac.entry_element_id AS entryElementId,
              ac.created_at AS createdAt
       FROM attack_chains ac
       WHERE ac.id = ? AND ac.project_id = ?
       LIMIT 1`,
      [chainId, projectId],
    );
    if (!chain) { res.status(404).json({ error: 'Attack chain not found' }); return; }

    const elementIds = typeof chain.elementIds === 'string' ? JSON.parse(chain.elementIds) : chain.elementIds || [];
    const findingIds = typeof chain.findingIds === 'string' ? JSON.parse(chain.findingIds) : chain.findingIds || [];

    // Hydrate elements and findings
    let elements = [];
    if (elementIds.length) {
      const ph = elementIds.map(() => '?').join(',');
      [elements] = await pool.query(
        `SELECT id, element_type AS elementType, file_path AS filePath,
                line_start AS lineStart, identifier, parent_element_id AS parentElementId, metadata
         FROM code_elements WHERE id IN (${ph})`,
        elementIds,
      );
    }

    let findings = [];
    if (findingIds.length) {
      const ph = findingIds.map(() => '?').join(',');
      [findings] = await pool.query(
        `SELECT id, severity, category, description, file_path AS filePath,
                line_number AS lineNumber, snippet, status
         FROM project_findings WHERE id IN (${ph})`,
        findingIds,
      );
    }

    res.json({
      ...chain,
      elementIds,
      findingIds,
      metadata: typeof chain.metadata === 'string' ? JSON.parse(chain.metadata) : chain.metadata,
      elements: elements.map((e) => ({
        ...e,
        metadata: typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata,
      })),
      findings,
    });
  } catch (e) {
    next(e);
  }
});

// ─── Memory Page Endpoints ──────────────────────────────────────────────────

// --- Memory Table (unified) ---
projectsRouter.get('/projects/:id/memory-table', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, latest_scan_id AS latestScanId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const scanId = project.latestScanId;

    const [
      [findings],
      [dismissals],
      [regressions],
      risks,
      fixOutcomesResult,
      [baselineRows],
      [profiles],
    ] = await Promise.all([
      scanId
        ? pool.query(
            `SELECT id, fingerprint, severity, category, file_path AS filePath,
                    line_number AS lineNumber, status, weighted_score AS weightedScore,
                    description, created_at AS createdAt
             FROM project_findings
             WHERE project_id = ? AND scan_id = ?
             ORDER BY FIELD(severity, 'critical', 'high', 'medium', 'low'), weighted_score DESC
             LIMIT 200`,
            [projectId, scanId],
          )
        : [[]],
      pool.query(
        `SELECT id, fingerprint, reason_code AS reason, scope, is_active AS isActive, created_at AS createdAt
         FROM finding_dismissals
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 200`,
        [projectId],
      ),
      pool.query(
        `SELECT id, fingerprint, resolved_in_scan_id AS resolvedInScanId,
                reappeared_in_scan_id AS reappearedInScanId, created_at AS createdAt
         FROM finding_regressions
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 200`,
        [projectId],
      ),
      getAcceptedRisks(pool, projectId),
      (async () => {
        const [[stats]] = await pool.query(
          `SELECT COUNT(*) AS total, SUM(pr_status = 'merged') AS merged,
                  SUM(pr_status = 'closed') AS closed, SUM(pr_status = 'open') AS open
           FROM fix_outcomes WHERE project_id = ?`,
          [projectId],
        );
        const [data] = await pool.query(
          `SELECT id, pr_url AS prUrl, pr_status AS prStatus,
                  fix_category AS fixCategory, files_changed AS filesChanged,
                  merged_at AS mergedAt, created_at AS createdAt
           FROM fix_outcomes WHERE project_id = ?
           ORDER BY created_at DESC LIMIT 100`,
          [projectId],
        );
        const total = Number(stats?.total || 0);
        const merged = Number(stats?.merged || 0);
        return {
          stats: {
            total,
            merged,
            closed: Number(stats?.closed || 0),
            open: Number(stats?.open || 0),
            mergeRate: total > 0 ? Math.round((merged / total) * 100) : null,
          },
          data,
        };
      })(),
      pool.query(
        `SELECT baseline_score AS baselineScore, baseline_finding_count AS baselineFindingCount,
                score_stddev AS scoreStddev, window_size AS windowSize,
                last_recalculated_at AS lastRecalculatedAt
         FROM scan_baselines WHERE project_id = ? LIMIT 1`,
        [projectId],
      ),
      pool.query(
        `SELECT id, author_email AS authorEmail, author_name AS authorName,
                total_findings_introduced AS totalFindings,
                critical_count AS criticalCount, high_count AS highCount,
                medium_count AS mediumCount, low_count AS lowCount,
                risk_score AS riskScore
         FROM developer_profiles WHERE project_id = ?
         ORDER BY risk_score DESC LIMIT 50`,
        [projectId],
      ),
    ]);

    const baseline = baselineRows[0]
      ? {
          baselineScore: Number(baselineRows[0].baselineScore || 0),
          baselineFindingCount: Number(baselineRows[0].baselineFindingCount || 0),
          scoreStddev: Number(baselineRows[0].scoreStddev || 0),
          windowSize: Number(baselineRows[0].windowSize || 0),
          lastRecalculatedAt: baselineRows[0].lastRecalculatedAt,
        }
      : null;

    res.json({
      findings,
      dismissals: dismissals.map((d) => ({ ...d, isActive: Boolean(d.isActive) })),
      regressions,
      acceptedRisks: risks,
      fixOutcomes: fixOutcomesResult,
      baseline,
      developerProfiles: profiles.map((p) => ({ ...p, riskScore: Number(p.riskScore) })),
    });
  } catch (e) {
    next(e);
  }
});

// --- Memory Graph (real nodes + links) ---
projectsRouter.get('/projects/:id/memory-graph', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId, project_name AS projectName, latest_scan_id AS latestScanId
       FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    const nodes = [];
    const links = [];

    // 1. Project node
    nodes.push({
      id: `project-${projectId}`,
      name: project.projectName || 'Project',
      group: 'project',
      summary: `Project root`,
      meta: [{ label: 'ID', value: projectId }],
    });

    // 2. Latest scans (up to 5)
    const [scans] = await pool.query(
      `SELECT id, status, security_score AS securityScore, findings_count AS findingsCount,
              created_at AS createdAt
       FROM project_scans
       WHERE project_id = ? AND status = 'completed'
       ORDER BY created_at DESC LIMIT 5`,
      [projectId],
    );
    for (const s of scans) {
      const nodeId = `scan-${s.id}`;
      nodes.push({
        id: nodeId,
        name: `Scan ${String(s.id).slice(0, 8)}`,
        group: 'event',
        summary: `Score: ${s.securityScore ?? '—'} | Findings: ${s.findingsCount ?? 0}`,
        meta: [
          { label: 'Status', value: s.status },
          { label: 'Score', value: String(s.securityScore ?? '—') },
          { label: 'Findings', value: String(s.findingsCount ?? 0) },
        ],
        updatedAt: s.createdAt ? new Date(s.createdAt).toISOString() : undefined,
      });
      links.push({ source: `project-${projectId}`, target: nodeId, kind: 'derived' });
    }

    // 3. Baseline node
    const [[baseline]] = await pool.query(
      `SELECT baseline_score AS baselineScore, baseline_finding_count AS baselineFindingCount,
              score_stddev AS scoreStddev, window_size AS windowSize
       FROM scan_baselines WHERE project_id = ? LIMIT 1`,
      [projectId],
    );
    if (baseline) {
      nodes.push({
        id: `baseline-${projectId}`,
        name: 'Scan Baseline',
        group: 'memory',
        summary: `Score: ${Number(baseline.baselineScore).toFixed(2)} | StdDev: ${Number(baseline.scoreStddev).toFixed(3)}`,
        meta: [
          { label: 'Baseline Score', value: String(Number(baseline.baselineScore).toFixed(2)) },
          { label: 'Finding Count', value: String(baseline.baselineFindingCount) },
          { label: 'Window', value: `${baseline.windowSize} scans` },
        ],
      });
      links.push({ source: `project-${projectId}`, target: `baseline-${projectId}`, kind: 'derived' });
    }

    // 4. Active dismissals
    const [dismissals] = await pool.query(
      `SELECT fingerprint, reason_code AS reason, created_at AS createdAt
       FROM finding_dismissals WHERE project_id = ? AND is_active = 1
       ORDER BY created_at DESC LIMIT 10`,
      [projectId],
    );
    for (const d of dismissals) {
      const nodeId = `dismissal-${d.fingerprint}`;
      nodes.push({
        id: nodeId,
        name: `Dismissed: ${d.fingerprint.slice(0, 12)}`,
        group: 'memory',
        summary: d.reason || 'No reason given',
        meta: [{ label: 'Fingerprint', value: d.fingerprint }],
        updatedAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
      });
      links.push({ source: `project-${projectId}`, target: nodeId, kind: 'resolved' });
    }

    // 5. Regressions
    const [regressions] = await pool.query(
      `SELECT fingerprint, resolved_in_scan_id AS resolvedScan, reappeared_in_scan_id AS reappearedScan,
              created_at AS createdAt
       FROM finding_regressions WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [projectId],
    );
    for (const r of regressions) {
      const nodeId = `regression-${r.fingerprint}-${r.reappearedScan}`;
      nodes.push({
        id: nodeId,
        name: `Regression: ${r.fingerprint.slice(0, 12)}`,
        group: 'finding',
        summary: `Reappeared in scan ${String(r.reappearedScan).slice(0, 8)}`,
        meta: [
          { label: 'Fingerprint', value: r.fingerprint },
          { label: 'Resolved Scan', value: String(r.resolvedScan).slice(0, 8) },
          { label: 'Reappeared Scan', value: String(r.reappearedScan).slice(0, 8) },
        ],
        updatedAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      });
      links.push({ source: `project-${projectId}`, target: nodeId, kind: 'caused' });
    }

    // 6. Top findings by score (latest scan)
    if (project.latestScanId) {
      const [topFindings] = await pool.query(
        `SELECT id, fingerprint, severity, category, file_path AS filePath,
                weighted_score AS weightedScore
         FROM project_findings
         WHERE project_id = ? AND scan_id = ?
         ORDER BY weighted_score DESC LIMIT 10`,
        [projectId, project.latestScanId],
      );
      for (const f of topFindings) {
        const nodeId = `finding-${f.id}`;
        nodes.push({
          id: nodeId,
          name: `${f.severity}: ${f.category}`,
          group: 'finding',
          summary: f.filePath || '',
          meta: [
            { label: 'Severity', value: f.severity },
            { label: 'Category', value: f.category },
            { label: 'Score', value: String(f.weightedScore) },
          ],
        });
        const scanNodeId = `scan-${project.latestScanId}`;
        if (nodes.some((n) => n.id === scanNodeId)) {
          links.push({ source: scanNodeId, target: nodeId, kind: 'derived' });
        } else {
          links.push({ source: `project-${projectId}`, target: nodeId, kind: 'derived' });
        }
      }
    }

    // 7. Fix outcomes (merged PRs)
    const [fixes] = await pool.query(
      `SELECT id, pr_url AS prUrl, pr_status AS prStatus, fix_category AS fixCategory,
              merged_at AS mergedAt
       FROM fix_outcomes WHERE project_id = ? AND pr_status = 'merged'
       ORDER BY merged_at DESC LIMIT 8`,
      [projectId],
    );
    for (const f of fixes) {
      const nodeId = `fix-${f.id}`;
      nodes.push({
        id: nodeId,
        name: `Fix: ${f.fixCategory || 'PR'}`,
        group: 'remediation',
        summary: f.prUrl || '',
        meta: [
          { label: 'Status', value: f.prStatus },
          { label: 'Category', value: f.fixCategory || '—' },
        ],
        updatedAt: f.mergedAt ? new Date(f.mergedAt).toISOString() : undefined,
      });
      links.push({ source: `project-${projectId}`, target: nodeId, kind: 'resolved' });
    }

    // 8. Embedding collection nodes (1 per collection with point count)
    if (isVectorEnabled()) {
      const qdrantBase = env.qdrant.url?.replace(/\/+$/, '') || '';
      const qdrantHdrs = env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};
      const collections = [
        { name: env.qdrant.findingCollection, label: 'Finding Embeddings' },
        { name: env.qdrant.fixCollection, label: 'Fix Embeddings' },
        { name: env.qdrant.codePatternCollection, label: 'Code Pattern Embeddings' },
      ];
      for (const col of collections) {
        try {
          const resp = await axios.get(
            `${qdrantBase}/collections/${encodeURIComponent(col.name)}`,
            { headers: qdrantHdrs, timeout: 5000 },
          );
          const info = resp.data?.result;
          const count = info?.points_count ?? info?.vectors_count ?? 0;
          const nodeId = `embedding-${col.name}`;
          nodes.push({
            id: nodeId,
            name: col.label,
            group: 'embedding',
            summary: `${count} vectors`,
            meta: [
              { label: 'Collection', value: col.name },
              { label: 'Points', value: String(count) },
              { label: 'Status', value: info?.status || 'unknown' },
            ],
          });
          links.push({ source: `project-${projectId}`, target: nodeId, kind: 'indexed' });
        } catch {
          // collection may not exist yet
        }
      }
    }

    res.json({ nodes, links });
  } catch (e) {
    next(e);
  }
});

// --- Vector Stats ---
projectsRouter.get('/projects/:id/vector-stats', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!isVectorEnabled()) {
      res.json({ enabled: false, collections: [] });
      return;
    }

    const qdrantBase = env.qdrant.url?.replace(/\/+$/, '') || '';
    const qdrantHdrs = env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};
    const collectionNames = [
      env.qdrant.findingCollection,
      env.qdrant.fixCollection,
      env.qdrant.codePatternCollection,
    ];

    const collections = await Promise.all(
      collectionNames.map(async (name) => {
        try {
          const resp = await axios.get(
            `${qdrantBase}/collections/${encodeURIComponent(name)}`,
            { headers: qdrantHdrs, timeout: 5000 },
          );
          const info = resp.data?.result;
          return {
            name,
            pointsCount: info?.points_count ?? info?.vectors_count ?? 0,
            status: info?.status || 'unknown',
          };
        } catch {
          return { name, pointsCount: 0, status: 'not_found' };
        }
      }),
    );

    res.json({ enabled: true, collections });
  } catch (e) {
    next(e);
  }
});

// --- Vector Scroll (paginated point listing) ---
projectsRouter.get('/projects/:id/vector-scroll', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!isVectorEnabled()) {
      res.json({ points: [], nextOffset: null });
      return;
    }

    const collection = String(req.query.collection || env.qdrant.findingCollection);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = req.query.offset || null;

    const qdrantBase = env.qdrant.url?.replace(/\/+$/, '') || '';
    const qdrantHdrs = env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};

    const body = {
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: 'project_id', match: { value: projectId } }],
      },
    };
    if (offset) body.offset = offset;

    const resp = await axios.post(
      `${qdrantBase}/collections/${encodeURIComponent(collection)}/points/scroll`,
      body,
      { headers: qdrantHdrs, timeout: 15000 },
    );

    const result = resp.data?.result || {};
    res.json({
      points: (result.points || []).map((p) => ({
        id: p.id,
        payload: p.payload || {},
      })),
      nextOffset: result.next_page_offset ?? null,
    });
  } catch (e) {
    if (e?.response?.status === 404) {
      res.json({ points: [], nextOffset: null });
      return;
    }
    next(e);
  }
});

// --- Vector Reduce (PCA 2D projection) ---
projectsRouter.get('/projects/:id/vector-reduce', requireUser, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const pool = getPool();
    const [[project]] = await pool.query(
      `SELECT id, user_id AS userId FROM projects WHERE id = ? LIMIT 1`,
      [projectId],
    );
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.userId !== req.userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!isVectorEnabled()) {
      res.json({ collection: '', points: [], reductionMethod: 'pca', totalPointsInCollection: 0 });
      return;
    }

    const collection = String(req.query.collection || env.qdrant.findingCollection);
    const maxPoints = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

    const qdrantBase = env.qdrant.url?.replace(/\/+$/, '') || '';
    const qdrantHdrs = env.qdrant.apiKey ? { 'api-key': env.qdrant.apiKey } : {};

    // Get collection info for total count
    let totalPointsInCollection = 0;
    try {
      const infoResp = await axios.get(
        `${qdrantBase}/collections/${encodeURIComponent(collection)}`,
        { headers: qdrantHdrs, timeout: 5000 },
      );
      totalPointsInCollection = infoResp.data?.result?.points_count ?? 0;
    } catch {
      // ignore
    }

    // Scroll with vectors for reduction
    const scrollResp = await axios.post(
      `${qdrantBase}/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        limit: maxPoints,
        with_payload: true,
        with_vector: true,
        filter: {
          must: [{ key: 'project_id', match: { value: projectId } }],
        },
      },
      { headers: qdrantHdrs, timeout: 30000 },
    );

    const rawPoints = scrollResp.data?.result?.points || [];
    if (rawPoints.length === 0) {
      res.json({ collection, points: [], reductionMethod: 'pca', totalPointsInCollection });
      return;
    }

    const vectors = rawPoints.map((p) => p.vector);
    const coords = reduceToPCA2D(vectors);

    const points = rawPoints.map((p, i) => ({
      id: p.id,
      x: coords[i].x,
      y: coords[i].y,
      payload: p.payload || {},
    }));

    res.json({ collection, points, reductionMethod: 'pca', totalPointsInCollection });
  } catch (e) {
    if (e?.response?.status === 404) {
      res.json({
        collection: String(req.query.collection || ''),
        points: [],
        reductionMethod: 'pca',
        totalPointsInCollection: 0,
      });
      return;
    }
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

