/**
 * Builds structured compliance-report payload from scans, findings, and resolution jobs.
 */

function mapCategoryToRiskArea(category) {
  const c = String(category || '').toLowerCase();
  if (/auth|session|jwt|oauth|password|credential|permission|rbac|acl/.test(c)) {
    return 'Authentication & access control weaknesses';
  }
  if (/sql|injection|database|query|orm|nosql/.test(c)) {
    return 'Database & schema / query risks';
  }
  if (/xss|csrf|input|validation|sanit|injection|path traversal|ssrf/.test(c)) {
    return 'Input validation & injection-safety gaps';
  }
  if (/crypto|secret|encryption|tls|hash|key/.test(c)) {
    return 'Cryptography & secrets management';
  }
  if (/docker|container|network|infra|deployment|config/.test(c)) {
    return 'Infrastructure & deployment';
  }
  if (/depend|supply|package|npm|pip/.test(c)) {
    return 'Dependency & supply chain';
  }
  return 'General application security';
}

function scoreToOverallRisk(securityScore) {
  if (securityScore == null || Number.isNaN(Number(securityScore))) return 'Unknown';
  const s = Number(securityScore);
  if (s <= 8) return 'Low';
  if (s <= 18) return 'Moderate';
  if (s <= 32) return 'High';
  return 'Severe';
}

function inferImpact(severity, category, description) {
  const d = String(description || '').slice(0, 320);
  const base = {
    critical: 'Material risk to confidentiality, integrity, or availability if exploited.',
    high: 'Significant exposure that could enable privilege abuse or data compromise.',
    medium: 'Meaningful weakness that increases attack surface or complicates defense in-depth.',
    low: 'Minor issue or hardening opportunity with limited direct exploitability.',
  }[severity] || 'Security-relevant finding in the analyzed codebase.';
  return d ? `${base} ${d}` : base;
}

function inferExploitPath(category, description, snippet) {
  const s = String(snippet || '').trim().slice(0, 200);
  const desc = String(description || '').trim();
  if (desc.length > 40) {
    return `Attacker leverages the described condition: ${desc.slice(0, 280)}${desc.length > 280 ? '…' : ''}`;
  }
  if (s) {
    return `Review the referenced code path; typical exploitation follows unsafe handling of untrusted input near: ${s}${s.length >= 200 ? '…' : ''}`;
  }
  return `Exploitation path depends on runtime context; category “${category || 'unknown'}” indicates where to prioritize review and testing.`;
}

function verdictLines({ criticalUnresolved, highUnresolved, securityScore }) {
  if (criticalUnresolved > 0) {
    return {
      headline: 'Critical open issues require attention',
      subtext: `${criticalUnresolved} critical finding(s) remain unresolved. Address before treating the system as production-ready.`,
      tone: 'warn',
    };
  }
  if (highUnresolved > 0) {
    return {
      headline: 'Production-ready with minor residual risks',
      subtext: `No critical vulnerabilities remain open; ${highUnresolved} high-severity item(s) still tracked for remediation.`,
      tone: 'ok',
    };
  }
  const s = securityScore == null ? null : Number(securityScore);
  if (s != null && s <= 12) {
    return {
      headline: 'No critical vulnerabilities remain open',
      subtext: 'Latest snapshot shows a strong posture; continue monitoring as code changes.',
      tone: 'strong',
    };
  }
  return {
    headline: 'No critical or high-severity items open',
    subtext: 'Review medium/low findings for defense-in-depth and compliance completeness.',
    tone: 'ok',
  };
}

function buildStrengths({ scanCount, completedResolutions, securityScore, findingsTotal }) {
  const out = [];
  if (scanCount >= 2) {
    out.push('Continuous scanning: multiple repository snapshots on record.');
  } else if (scanCount === 1) {
    out.push('Security scanning enabled for this repository.');
  }
  out.push(
    'Exploit-oriented analysis: findings include file/line context to support realistic exploit-path discussion and validation testing.',
  );
  out.push('Structured analysis of exploitable code paths in the scanned snapshot (severity-weighted).');
  if (findingsTotal > 0) {
    out.push('Findings mapped to categories to prioritize remediation and audit discussion.');
  }
  if (completedResolutions > 0) {
    out.push('Signal resolution workflows used to drive fixes via pull requests where applicable.');
  }
  const s = securityScore == null ? null : Number(securityScore);
  if (s != null && s <= 10 && findingsTotal > 0) {
    out.push('Latest security score indicates a comparatively strong posture for the analyzed commit tree.');
  }
  return out.slice(0, 6);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} projectId
 * @param {string} userId
 */
export async function buildComplianceReportPayload(pool, projectId, userId) {
  const [[project]] = await pool.query(
    `SELECT id,
            user_id AS userId,
            project_name AS projectName,
            github_url AS githubUrl,
            description,
            created_at AS createdAt
     FROM projects WHERE id = ? LIMIT 1`,
    [projectId],
  );

  if (!project) return { error: 'not_found' };
  if (project.userId !== userId) return { error: 'forbidden' };

  const [[latestCompleted]] = await pool.query(
    `SELECT id, status, findings_count AS findingsCount, scanned_files_count AS scannedFilesCount,
            security_score AS securityScore, summary_json AS summary, created_at AS createdAt, finished_at AS finishedAt
     FROM project_scans
     WHERE project_id = ? AND status = 'completed'
     ORDER BY COALESCE(finished_at, created_at) DESC
     LIMIT 1`,
    [projectId],
  );

  const [[scanCountRow]] = await pool.query(
    `SELECT COUNT(*) AS n FROM project_scans WHERE project_id = ? AND status = 'completed'`,
    [projectId],
  );
  const scanCount = Number(scanCountRow?.n || 0);

  if (!latestCompleted) {
    return {
      ok: true,
      project: {
        id: project.id,
        projectName: project.projectName,
        githubUrl: project.githubUrl,
        description: project.description,
      },
      scan: null,
      executiveSummary: null,
      riskAreas: [],
      signalFixes: null,
      strengths: [],
      verdict: null,
      timeline: [],
      evidence: [],
      emptyReason: 'no_completed_scan',
    };
  }

  const scanId = latestCompleted.id;

  const [findings] = await pool.query(
    `SELECT id, severity, category, description, line_number AS lineNumber,
            weighted_score AS weightedScore, file_path AS filePath, snippet,
            status, created_at AS createdAt
     FROM project_findings
     WHERE project_id = ? AND scan_id = ?
     ORDER BY weighted_score DESC, created_at DESC`,
    [projectId, scanId],
  );

  const [jobs] = await pool.query(
    `SELECT id, finding_ids AS findingIds, pr_url AS prUrl, status, created_at AS createdAt, updated_at AS updatedAt
     FROM resolution_jobs
     WHERE project_id = ?
     ORDER BY created_at DESC
     LIMIT 200`,
    [projectId],
  );

  const findingToResolution = new Map();
  for (const job of jobs) {
    if (job.status !== 'completed' || !job.prUrl) continue;
    let ids = job.findingIds;
    if (typeof ids === 'string') {
      try {
        ids = JSON.parse(ids);
      } catch {
        ids = [];
      }
    }
    if (!Array.isArray(ids)) continue;
    for (const fid of ids) {
      if (!findingToResolution.has(String(fid))) {
        findingToResolution.set(String(fid), { prUrl: job.prUrl, jobId: job.id, completedAt: job.updatedAt });
      }
    }
  }

  const [[avgFixRow]] = await pool.query(
    `SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, updated_at)) / 60.0 AS avgHours
     FROM resolution_jobs
     WHERE project_id = ? AND status = 'completed'`,
    [projectId],
  );
  const avgFixHours =
    avgFixRow?.avgHours != null && !Number.isNaN(Number(avgFixRow.avgHours))
      ? Math.round(Number(avgFixRow.avgHours) * 10) / 10
      : null;

  const sev = { critical: 0, high: 0, medium: 0, low: 0 };
  let criticalUnresolved = 0;
  let highUnresolved = 0;
  const areaMap = new Map();

  for (const f of findings) {
    const sv = f.severity;
    if (Object.prototype.hasOwnProperty.call(sev, sv)) sev[sv] += 1;
    else sev.low += 1;

    if (sv === 'critical' && f.status !== 'resolved') criticalUnresolved += 1;
    if (sv === 'high' && f.status !== 'resolved') highUnresolved += 1;

    const area = mapCategoryToRiskArea(f.category);
    const cur = areaMap.get(area) || { label: area, categories: new Set(), count: 0 };
    cur.count += 1;
    cur.categories.add(f.category);
    areaMap.set(area, cur);
  }

  const riskAreas = [...areaMap.values()]
    .map((a) => ({
      label: a.label,
      findingCount: a.count,
      exampleCategories: [...a.categories].slice(0, 4),
    }))
    .sort((x, y) => y.findingCount - x.findingCount);

  const countSevResolved = (s) =>
    findings.filter((f) => f.severity === s && f.status === 'resolved').length;
  const countSev = (s) => findings.filter((f) => f.severity === s).length;

  const critTotal = countSev('critical');
  const highTotal = countSev('high');
  const critResolved = countSevResolved('critical');
  const highResolved = countSevResolved('high');

  const pct = (resolved, total) => (total === 0 ? 100 : Math.round((100 * resolved) / total));

  const securityScore = latestCompleted.securityScore != null ? Number(latestCompleted.securityScore) : null;
  const overallRisk = scoreToOverallRisk(securityScore);

  const completedResolutions = jobs.filter((j) => j.status === 'completed' && j.prUrl).length;

  const executiveSummary = {
    overallRisk,
    criticalIssues: sev.critical,
    highIssues: sev.high,
    mediumIssues: sev.medium,
    lowIssues: sev.low,
    criticalUnresolved,
    highUnresolved,
    statusLine:
      criticalUnresolved > 0
        ? `${criticalUnresolved} critical unresolved`
        : highUnresolved > 0
          ? `${highUnresolved} high-severity unresolved`
          : 'No critical or high-severity items open',
    securityScore,
    scannedFiles: latestCompleted.scannedFilesCount,
  };

  const signalFixes = {
    criticalResolvedPct: pct(critResolved, critTotal),
    highResolvedPct: pct(highResolved, highTotal),
    avgFixHours,
    criticalResolved: critResolved,
    criticalTotal: critTotal,
    highResolved: highResolved,
    highTotal: highTotal,
  };

  const strengths = buildStrengths({
    scanCount,
    completedResolutions,
    securityScore,
    findingsTotal: findings.length,
  });

  const verdict = verdictLines({ criticalUnresolved, highUnresolved, securityScore });

  const timeline = [];

  const [recentScans] = await pool.query(
    `SELECT id, status, security_score AS securityScore, created_at AS createdAt, finished_at AS finishedAt, findings_count AS findingsCount
     FROM project_scans
     WHERE project_id = ?
     ORDER BY created_at DESC
     LIMIT 15`,
    [projectId],
  );

  for (const s of recentScans) {
    timeline.push({
      at: s.finishedAt || s.createdAt,
      type: 'scan',
      label:
        s.status === 'completed'
          ? `Scan completed — score ${s.securityScore ?? '—'} (${s.findingsCount ?? 0} findings)`
          : `Scan ${s.status}`,
      evidence: { scanId: s.id },
    });
  }

  for (const job of jobs) {
    if (job.status === 'completed' && job.prUrl) {
      timeline.push({
        at: job.updatedAt || job.createdAt,
        type: 'resolution',
        label: `Resolution job completed — PR opened`,
        evidence: { jobId: job.id, prUrl: job.prUrl },
      });
    }
  }

  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const evidence = findings.slice(0, 25).map((f) => {
    const res = findingToResolution.get(String(f.id));
    const fixed =
      f.status === 'resolved'
        ? res
          ? `Addressed via Signal resolution (see PR).`
          : 'Marked resolved (verify in your change-management system).'
        : f.status === 'in_progress'
          ? 'Fix in progress via Signal or manual workflow.'
          : 'Open — scheduled for remediation.';

    return {
      id: f.id,
      severity: f.severity,
      category: f.category,
      title: String(f.description || f.category || 'Finding').slice(0, 120),
      impact: inferImpact(f.severity, f.category, f.description),
      exploitPath: inferExploitPath(f.category, f.description, f.snippet),
      whatWasFixed: fixed,
      status: f.status,
      prUrl: res?.prUrl ?? null,
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      createdAt: f.createdAt,
    };
  });

  let summaryParsed = null;
  if (latestCompleted.summary) {
    try {
      summaryParsed =
        typeof latestCompleted.summary === 'string' ? JSON.parse(latestCompleted.summary) : latestCompleted.summary;
    } catch {
      summaryParsed = null;
    }
  }

  return {
    ok: true,
    project: {
      id: project.id,
      projectName: project.projectName,
      githubUrl: project.githubUrl,
      description: project.description,
    },
    scan: {
      id: latestCompleted.id,
      finishedAt: latestCompleted.finishedAt,
      createdAt: latestCompleted.createdAt,
      securityScore,
      scannedFilesCount: latestCompleted.scannedFilesCount,
      findingsCount: findings.length,
      summary: summaryParsed,
    },
    executiveSummary,
    riskAreas,
    signalFixes,
    strengths,
    verdict,
    timeline: timeline.slice(0, 25),
    evidence,
    emptyReason: null,
  };
}

function isoStamp(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeMdCell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, ' ')
    .trim();
}

function truncateMd(s, max = 600) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * Professional Markdown / README-style export with Signal branding and structure.
 * @param {object} payload — result of buildComplianceReportPayload (success or empty)
 */
export function complianceReportToMarkdown(payload) {
  const generated = isoStamp();
  const brand = 'Signal';
  const tagline = 'Security & compliance documentation';

  const docTitle = `${payload?.project?.projectName || 'Compliance report'} — ${tagline}`;
  const header = [
    '---',
    `title: ${JSON.stringify(docTitle)}`,
    `generator: ${JSON.stringify(brand)}`,
    'document_type: security_compliance_narrative',
    `generated_at: ${JSON.stringify(generated)}`,
    '---',
    '',
    '<!-- SIGNAL • CONFIDENTIAL • Generated by Signal. For authorized use only. -->',
    '',
    '```',
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║  SIGNAL                                                                      ║',
    `║  ${tagline.padEnd(76)}║`,
    '║  This file is a machine-generated supporting narrative for audit readiness.  ║',
    '║  It is not a SOC 2 attestation, certification, or legal opinion.             ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '```',
    '',
    '> **Brand watermark:** *Signal* — automated repository security analysis and compliance-ready reporting.',
    '',
    '---',
    '',
  ];

  const project = payload?.project;
  if (!project) {
    return [...header, '## Error', '', 'Project data unavailable.', '', footerWatermark(generated)].join('\n');
  }

  if (payload.emptyReason === 'no_completed_scan') {
    const body = [
      `# ${escapeMdCell(project.projectName)}`,
      '',
      '## Status',
      '',
      '**No completed security scan** is available for this repository. Run a scan from the Signal dashboard, then regenerate this document.',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **Project** | ${escapeMdCell(project.projectName)} |`,
      `| **Repository** | ${escapeMdCell(project.githubUrl)} |`,
      `| **Generated** | ${generated} |`,
      '',
      footerWatermark(generated),
    ];
    return [...header, ...body].join('\n');
  }

  const es = payload.executiveSummary;
  const scan = payload.scan;
  const docControl = [
    '## Document control',
    '',
    '> **Distribution:** For internal governance, security review, and authorized auditors. Rename to `README.md` if you want GitHub-style rendering in a documentation repository.',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Report title** | Security & compliance narrative — ${escapeMdCell(project.projectName)} |`,
    `| **Generated (UTC)** | ${generated} |`,
    `| **Repository** | ${escapeMdCell(project.githubUrl)} |`,
    `| **Evidence scan ID** | ${escapeMdCell(scan?.id)} |`,
    `| **Scan completed** | ${escapeMdCell(scan?.finishedAt || scan?.createdAt || '—')} |`,
    `| **Files analyzed** | ${scan?.scannedFilesCount ?? '—'} |`,
    `| **Findings in snapshot** | ${scan?.findingsCount ?? '—'} |`,
    '',
    '## Table of contents',
    '',
    '1. [Executive summary](#1-executive-summary)',
    '2. [High-level risk areas](#2-high-level-risk-areas)',
    '3. [Remediation & Signal workflows](#3-remediation--signal-workflows)',
    '4. [Security strengths](#4-security-strengths)',
    '5. [Final verdict](#5-final-verdict)',
    '6. [Timeline & evidence](#6-timeline--evidence)',
    '7. [Finding detail](#7-finding-detail)',
    '',
    '---',
    '',
  ];

  const exec = [
    '## 1. Executive summary',
    '',
    '_Designed for a 10–15 second executive read._',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| **Overall risk** | **${escapeMdCell(es?.overallRisk)}** |`,
    `| **Critical issues** | ${es?.criticalIssues ?? '—'} |`,
    `| **High issues** | ${es?.highIssues ?? '—'} |`,
    `| **Medium / Low** | ${es?.mediumIssues ?? '—'} / ${es?.lowIssues ?? '—'} |`,
    `| **Security score** (0–50, lower is better) | ${es?.securityScore ?? '—'} |`,
    `| **Status** | ${escapeMdCell(es?.statusLine)} |`,
    '',
  ];

  const riskIntro = [
    '## 2. High-level risk areas',
    '',
    'Findings are **grouped by theme** (not a flat dump of every item). Use the detailed section for line-level evidence.',
    '',
  ];

  const riskRows =
    (payload.riskAreas || []).length > 0
      ? [
          '| Theme | Findings | Example categories |',
          '|-------|----------|--------------------|',
          ...payload.riskAreas.map(
            (r) =>
              `| ${escapeMdCell(r.label)} | ${r.findingCount} | ${escapeMdCell(r.exampleCategories?.slice(0, 3).join(', ') || '—')} |`,
          ),
          '',
        ]
      : ['_No grouped risk areas._', ''];

  const fixes = payload.signalFixes;
  const fixSection = fixes
    ? [
        '## 3. Remediation & Signal workflows',
        '',
        '| Measure | Value |',
        '|---------|-------|',
        `| **Critical resolved** | ${fixes.criticalResolvedPct}% (${fixes.criticalResolved}/${fixes.criticalTotal}) |`,
        `| **High resolved** | ${fixes.highResolvedPct}% (${fixes.highResolved}/${fixes.highTotal}) |`,
        `| **Avg. resolution job duration** | ${fixes.avgFixHours != null ? `${fixes.avgFixHours} hours` : 'N/A'} |`,
        '',
        '_Percentages reflect finding status in Signal (e.g. resolved via PR workflow or manual closure)._',
        '',
      ]
    : ['## 3. Remediation & Signal workflows', '', '_No remediation statistics available._', ''];

  const strengths = [
    '## 4. Security strengths',
    '',
    ...((payload.strengths || []).map((s) => `- ${escapeMdCell(s)}`) || ['- _None listed._']),
    '',
  ];

  const verdict = payload.verdict
    ? [
        '## 5. Final verdict',
        '',
        `### ${escapeMdCell(payload.verdict.headline)}`,
        '',
        payload.verdict.subtext,
        '',
      ]
    : ['## 5. Final verdict', '', '_No verdict block._', ''];

  const tl = payload.timeline || [];
  const timeline = [
    '## 6. Timeline & evidence',
    '',
    '| When (UTC) | Event | Link / ID |',
    '|--------------|-------|-------------|',
    ...(tl.length > 0
      ? tl.map((t) => {
          const when = escapeMdCell(t.at);
          const label = escapeMdCell(t.label);
          const link = t.evidence?.prUrl ? `[PR](${t.evidence.prUrl})` : escapeMdCell(t.evidence?.scanId || '—');
          return `| ${when} | ${label} | ${link} |`;
        })
      : ['| — | No scan or resolution events recorded | — |']),
    '',
  ];

  const evidenceHeader = [
    '## 7. Finding detail',
    '',
    '_Impact, exploit-oriented discussion, and remediation status. Line references point to the scanned snapshot._',
    '',
  ];

  const evidenceBlocks = (payload.evidence || []).map((ev, i) => {
    const loc = `${ev.filePath || ''}${ev.lineNumber != null ? `:${ev.lineNumber}` : ''}`;
    return [
      `### ${i + 1}. [${escapeMdCell(ev.severity)}] ${escapeMdCell(ev.title)}`,
      '',
      `| Field | Detail |`,
      `|-------|--------|`,
      `| **Category** | ${escapeMdCell(ev.category)} |`,
      `| **Status** | ${escapeMdCell(ev.status)} |`,
      `| **Location** | \`${escapeMdCell(loc)}\` |`,
      '',
      '**Impact**',
      '',
      truncateMd(ev.impact),
      '',
      '**Exploit path**',
      '',
      truncateMd(ev.exploitPath),
      '',
      '**What was fixed / next step**',
      '',
      truncateMd(ev.whatWasFixed + (ev.prUrl ? ` ${ev.prUrl}` : '')),
      '',
      '---',
      '',
    ].join('\n');
  });

  return [
    ...header,
    `# ${escapeMdCell(project.projectName)}`,
    '',
    project.description ? `_${escapeMdCell(project.description)}_\n\n` : '',
    ...docControl,
    ...exec,
    ...riskIntro,
    ...riskRows,
    ...fixSection,
    ...strengths,
    ...verdict,
    ...timeline,
    ...evidenceHeader,
    evidenceBlocks.join('\n'),
    footerWatermark(generated),
  ].join('\n');
}

function footerWatermark(generated) {
  return [
    '',
    '---',
    '',
    '```',
    '══════════════════════════════════════════════════════════════════════════════',
    '  SIGNAL  ·  Automated security & compliance documentation',
    `  Generated: ${generated}`,
    '  Unauthorized redistribution is prohibited.',
    '══════════════════════════════════════════════════════════════════════════════',
    '```',
    '',
    `*End of report · ${generated} · ${'Signal'}*`,
    '',
  ].join('\n');
}

/**
 * Safe filename segment for Content-Disposition (ASCII, no path chars).
 */
export function complianceReportFilename(projectName) {
  const base = String(projectName || 'project')
    .replace(/[^\w\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'project';
  const day = new Date().toISOString().slice(0, 10);
  return `Signal-Compliance-${base}-${day}.md`;
}
