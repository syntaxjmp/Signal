/**
 * Phase 3b/3c — Attack chain detection, severity escalation, and narrative generation.
 */
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { attackChainNarrativePrompt } from '../ai/attackChainPrompt.js';

// ---------------------------------------------------------------------------
// 1. Build element relationships (parent_element_id assignment)
// ---------------------------------------------------------------------------

const PARENT_PROXIMITY = 50; // max lines between a child and its parent

export async function buildElementRelationships(pool, projectId, scanId) {
  const [rows] = await pool.query(
    `SELECT id, element_type AS elementType, file_path AS filePath, line_start AS lineStart, identifier
     FROM code_elements
     WHERE project_id = ? AND scan_id = ?
     ORDER BY file_path, line_start`,
    [projectId, scanId],
  );

  if (!rows.length) return 0;

  // Group by file
  const byFile = new Map();
  for (const row of rows) {
    const list = byFile.get(row.filePath) || [];
    list.push(row);
    byFile.set(row.filePath, list);
  }

  const updates = []; // { id, parentId }

  for (const elements of byFile.values()) {
    // Stack-based: walk elements sorted by line, track last route/handler
    let lastRoute = null;
    let lastHandler = null;

    for (const el of elements) {
      if (el.elementType === 'route') {
        lastRoute = el;
        lastHandler = null; // reset handler scope on new route
        continue;
      }

      if (el.elementType === 'handler') {
        // Handler on same line or within 2 lines of a route → child of route
        if (lastRoute && Math.abs(el.lineStart - lastRoute.lineStart) <= 2) {
          updates.push({ id: el.id, parentId: lastRoute.id });
          lastHandler = el;
        } else if (lastRoute && el.lineStart - lastRoute.lineStart <= PARENT_PROXIMITY) {
          updates.push({ id: el.id, parentId: lastRoute.id });
          lastHandler = el;
        }
        continue;
      }

      if (el.elementType === 'db_call' || el.elementType === 'auth_check') {
        // Prefer handler as parent, fall back to route
        const parent = lastHandler || lastRoute;
        if (parent && el.lineStart - parent.lineStart <= PARENT_PROXIMITY) {
          updates.push({ id: el.id, parentId: parent.id });
        }
        continue;
      }

      // middleware elements remain parentless (global scope)
    }
  }

  // Batch UPDATE parent_element_id
  if (updates.length) {
    const BATCH = 50;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const cases = batch.map(() => 'WHEN id = ? THEN ?').join(' ');
      const ids = batch.map((u) => u.id);
      const params = batch.flatMap((u) => [u.id, u.parentId]);
      params.push(...ids);
      await pool.query(
        `UPDATE code_elements
         SET parent_element_id = CASE ${cases} END
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        params,
      );
    }
  }

  return updates.length;
}

// ---------------------------------------------------------------------------
// 2. Link findings to code elements by file + line proximity
// ---------------------------------------------------------------------------

export async function linkFindingsToElements(pool, projectId, scanId, proximityWindow = 15) {
  // Delete stale links for this scan's elements first
  await pool.query(
    `DELETE efl FROM element_finding_links efl
     JOIN code_elements ce ON ce.id = efl.element_id
     WHERE ce.project_id = ? AND ce.scan_id = ?`,
    [projectId, scanId],
  );

  const [elements] = await pool.query(
    `SELECT id, file_path AS filePath, line_start AS lineStart
     FROM code_elements
     WHERE project_id = ? AND scan_id = ? AND line_start IS NOT NULL`,
    [projectId, scanId],
  );

  if (!elements.length) return 0;

  const [findings] = await pool.query(
    `SELECT id, file_path AS filePath, line_number AS lineNumber
     FROM project_findings
     WHERE project_id = ? AND scan_id = ? AND line_number IS NOT NULL`,
    [projectId, scanId],
  );

  if (!findings.length) return 0;

  // Build lookup: filePath -> findings
  const findingsByFile = new Map();
  for (const f of findings) {
    const list = findingsByFile.get(f.filePath) || [];
    list.push(f);
    findingsByFile.set(f.filePath, list);
  }

  const links = [];
  for (const el of elements) {
    const fileFnds = findingsByFile.get(el.filePath);
    if (!fileFnds) continue;
    for (const f of fileFnds) {
      const dist = Math.abs(f.lineNumber - el.lineStart);
      if (dist <= proximityWindow) {
        links.push({ elementId: el.id, findingId: f.id, proximity: dist });
      }
    }
  }

  if (!links.length) return 0;

  const BATCH = 50;
  for (let i = 0; i < links.length; i += BATCH) {
    const batch = links.slice(i, i + BATCH);
    const placeholders = batch.map(() => '(UUID(), ?, ?, ?)').join(', ');
    const values = batch.flatMap((l) => [l.elementId, l.findingId, l.proximity]);
    await pool.query(
      `INSERT IGNORE INTO element_finding_links (id, element_id, finding_id, proximity_lines)
       VALUES ${placeholders}`,
      values,
    );
  }

  return links.length;
}

// ---------------------------------------------------------------------------
// 3. Detect attack chains via recursive CTE
// ---------------------------------------------------------------------------

export async function detectAttackChains(pool, projectId, scanId) {
  // Recursive CTE: walk from route elements down through children (max 4 hops)
  const [chainRows] = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT id, id AS root_id, element_type, file_path, line_start, identifier, 1 AS depth
       FROM code_elements
       WHERE project_id = ? AND scan_id = ? AND element_type = 'route'
       UNION ALL
       SELECT child.id, chain.root_id, child.element_type, child.file_path, child.line_start, child.identifier, chain.depth + 1
       FROM code_elements child
       JOIN chain ON child.parent_element_id = chain.id
       WHERE chain.depth < 4
         AND child.project_id = ? AND child.scan_id = ?
     )
     SELECT
       root_id AS rootId,
       JSON_ARRAYAGG(chain.id) AS elementIds,
       MAX(depth) AS maxDepth,
       SUM(CASE WHEN element_type = 'db_call' THEN 1 ELSE 0 END) AS dbCallCount,
       SUM(CASE WHEN element_type = 'auth_check' THEN 1 ELSE 0 END) AS authCheckCount,
       SUM(CASE WHEN element_type = 'handler' THEN 1 ELSE 0 END) AS handlerCount
     FROM chain
     GROUP BY root_id
     HAVING dbCallCount > 0 AND authCheckCount = 0`,
    [projectId, scanId, projectId, scanId],
  );

  if (!chainRows.length) return 0;

  // For each chain root, gather correlated findings via element_finding_links
  const chains = [];
  for (const row of chainRows) {
    const elementIds = typeof row.elementIds === 'string' ? JSON.parse(row.elementIds) : row.elementIds;

    // Get findings linked to any element in this chain
    const placeholders = elementIds.map(() => '?').join(',');
    const [linkedFindings] = await pool.query(
      `SELECT DISTINCT f.id, f.severity, f.category, f.description, f.file_path AS filePath,
              f.line_number AS lineNumber, f.snippet
       FROM element_finding_links efl
       JOIN project_findings f ON f.id = efl.finding_id
       WHERE efl.element_id IN (${placeholders})`,
      elementIds,
    );

    const findingIds = linkedFindings.map((f) => f.id);

    // Classify chain type
    const hasInjection = linkedFindings.some((f) =>
      /injection|sql_injection|command_injection|xss|xpath|ldap|nosql/i.test(f.category),
    );
    const hasDataAccess = linkedFindings.some((f) =>
      /idor|path_traversal|ssrf|data_exposure|mass_assignment/i.test(f.category),
    );

    let chainType = 'missing_auth_route';
    if (hasInjection) chainType = 'unauth_injection';
    else if (hasDataAccess) chainType = 'unauth_data_access';

    // Escalate severity
    const { severity, escalatedFrom } = escalateSeverity(linkedFindings, chainType);

    // Get root element info
    const [[rootEl]] = await pool.query(
      `SELECT identifier, metadata FROM code_elements WHERE id = ?`,
      [row.rootId],
    );

    const chainId = uuidv4();
    chains.push({
      id: chainId,
      projectId,
      scanId,
      chainType,
      entryElementId: row.rootId,
      severity,
      escalatedFrom,
      hopCount: Number(row.maxDepth),
      elementIds,
      findingIds,
      metadata: {
        dbCallCount: Number(row.dbCallCount),
        authCheckCount: Number(row.authCheckCount),
        handlerCount: Number(row.handlerCount),
        entryRoute: rootEl?.identifier || null,
      },
    });
  }

  // Batch insert chains
  if (chains.length) {
    const BATCH = 20;
    for (let i = 0; i < chains.length; i += BATCH) {
      const batch = chains.slice(i, i + BATCH);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = batch.flatMap((c) => [
        c.id,
        c.projectId,
        c.scanId,
        c.chainType,
        c.entryElementId,
        c.severity,
        c.escalatedFrom,
        c.hopCount,
        JSON.stringify(c.elementIds),
        JSON.stringify(c.findingIds),
        JSON.stringify(c.metadata),
      ]);
      await pool.query(
        `INSERT INTO attack_chains
          (id, project_id, scan_id, chain_type, entry_element_id, severity, escalated_from,
           hop_count, element_ids, finding_ids, metadata)
         VALUES ${placeholders}`,
        values,
      );
    }
  }

  return chains.length;
}

// ---------------------------------------------------------------------------
// 4. Severity escalation — pure function
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function severityIndex(sev) {
  const idx = SEVERITY_ORDER.indexOf(sev);
  return idx === -1 ? 0 : idx;
}

function bumpSeverity(sev) {
  const idx = severityIndex(sev);
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)];
}

export function escalateSeverity(findings, chainType) {
  if (!findings.length) {
    // No correlated findings — chain is missing_auth_route by structure alone
    return { severity: 'high', escalatedFrom: null };
  }

  const maxSev = findings.reduce(
    (max, f) => (severityIndex(f.severity) > severityIndex(max) ? f.severity : max),
    'low',
  );

  const categories = new Set(findings.map((f) => f.category?.toLowerCase()));

  // missing_auth + injection → critical
  if (
    (chainType === 'missing_auth_route' || chainType === 'unauth_injection') &&
    (categories.has('sql_injection') || categories.has('command_injection') || categories.has('path_traversal'))
  ) {
    if (maxSev !== 'critical') {
      return { severity: 'critical', escalatedFrom: maxSev };
    }
    return { severity: 'critical', escalatedFrom: null };
  }

  // missing_auth + any db finding → high minimum
  if (chainType === 'missing_auth_route' || chainType === 'unauth_data_access') {
    if (severityIndex(maxSev) < severityIndex('high')) {
      return { severity: 'high', escalatedFrom: maxSev };
    }
  }

  // 3+ findings on same chain → bump max severity one level
  if (findings.length >= 3) {
    const bumped = bumpSeverity(maxSev);
    if (bumped !== maxSev) {
      return { severity: bumped, escalatedFrom: maxSev };
    }
  }

  return { severity: maxSev, escalatedFrom: null };
}

// ---------------------------------------------------------------------------
// 5. Generate narratives (template-based + AI for complex chains)
// ---------------------------------------------------------------------------

const TEMPLATE_NARRATIVES = {
  missing_auth_route: (meta) =>
    `The route ${meta.entryRoute || '(unknown)'} reaches a database call without any authentication or authorization check in the call chain. ` +
    `An unauthenticated attacker could invoke this endpoint and interact with the database directly. ` +
    `Add authentication middleware before any handler that accesses persistent storage.`,

  unauth_injection: (meta, findings) => {
    const injType = findings.find((f) => /injection/i.test(f.category))?.category || 'injection';
    return (
      `The route ${meta.entryRoute || '(unknown)'} is vulnerable to ${injType} and lacks authentication. ` +
      `An unauthenticated attacker can exploit the injection to read, modify, or delete data. ` +
      `This combination escalates to critical severity. Fix the injection vulnerability and add auth middleware.`
    );
  },

  unauth_data_access: (meta) =>
    `The route ${meta.entryRoute || '(unknown)'} exposes data access operations without authentication. ` +
    `Sensitive data may be accessible to any caller. ` +
    `Ensure proper authentication and authorization gates are in place before data retrieval or mutation.`,
};

export async function generateChainNarratives(pool, projectId, scanId, openAiApiKey, model) {
  const [chains] = await pool.query(
    `SELECT id, chain_type AS chainType, severity, finding_ids AS findingIds,
            element_ids AS elementIds, metadata, narrative
     FROM attack_chains
     WHERE project_id = ? AND scan_id = ? AND narrative IS NULL`,
    [projectId, scanId],
  );

  if (!chains.length) return 0;

  let generated = 0;

  for (const chain of chains) {
    const meta = typeof chain.metadata === 'string' ? JSON.parse(chain.metadata) : chain.metadata || {};
    const findingIds = typeof chain.findingIds === 'string' ? JSON.parse(chain.findingIds) : chain.findingIds || [];

    // Fetch correlated findings for narrative context
    let findings = [];
    if (findingIds.length) {
      const ph = findingIds.map(() => '?').join(',');
      [findings] = await pool.query(
        `SELECT id, severity, category, description FROM project_findings WHERE id IN (${ph})`,
        findingIds,
      );
    }

    let narrative = null;

    // Template-based for known types with few findings
    if (TEMPLATE_NARRATIVES[chain.chainType] && findings.length < 3) {
      narrative = TEMPLATE_NARRATIVES[chain.chainType](meta, findings);
    }

    // AI-generated for complex chains (3+ findings) — max 10 per scan
    if (!narrative && openAiApiKey && generated < 10) {
      try {
        const openai = new OpenAI({ apiKey: openAiApiKey });
        const chainPayload = {
          chain_type: chain.chainType,
          entry_route: meta.entryRoute,
          severity: chain.severity,
          elements: (typeof chain.elementIds === 'string' ? JSON.parse(chain.elementIds) : chain.elementIds || []).length + ' elements',
          findings: findings.map((f) => ({ category: f.category, severity: f.severity, description: f.description })),
        };

        const resp = await openai.chat.completions.create({
          model: model || 'gpt-4o-mini',
          temperature: 0.3,
          max_tokens: 300,
          messages: [
            { role: 'system', content: attackChainNarrativePrompt },
            { role: 'user', content: JSON.stringify(chainPayload) },
          ],
        });

        narrative = resp.choices?.[0]?.message?.content?.trim() || null;
      } catch (aiErr) {
        console.warn(`[attack-chains] AI narrative failed chain=${chain.id}`, aiErr?.message || aiErr);
        // Fall back to template if available
        if (TEMPLATE_NARRATIVES[chain.chainType]) {
          narrative = TEMPLATE_NARRATIVES[chain.chainType](meta, findings);
        }
      }
    }

    // Last resort: use template even for complex chains
    if (!narrative && TEMPLATE_NARRATIVES[chain.chainType]) {
      narrative = TEMPLATE_NARRATIVES[chain.chainType](meta, findings);
    }

    if (narrative) {
      await pool.execute(
        `UPDATE attack_chains SET narrative = ? WHERE id = ?`,
        [narrative, chain.id],
      );
      generated++;
    }
  }

  return generated;
}

// ---------------------------------------------------------------------------
// 6. Orchestrator
// ---------------------------------------------------------------------------

export async function analyzeAttackChains(pool, projectId, scanId, openAiApiKey, model) {
  const relationshipsBuilt = await buildElementRelationships(pool, projectId, scanId);
  const linksCreated = await linkFindingsToElements(pool, projectId, scanId);
  const chainsDetected = await detectAttackChains(pool, projectId, scanId);

  let narrativesGenerated = 0;
  if (chainsDetected > 0) {
    narrativesGenerated = await generateChainNarratives(pool, projectId, scanId, openAiApiKey, model);
  }

  return { relationshipsBuilt, linksCreated, chainsDetected, narrativesGenerated };
}
