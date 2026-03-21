import { v4 as uuidv4 } from 'uuid';

/**
 * SLA MVP:
 * - reads active `sla` policies
 * - finds open findings exceeding age threshold
 * - records violations once per finding/policy
 */
export async function runSlaChecksOnce(pool) {
  const [policies] = await pool.query(
    `SELECT id, project_id AS projectId, condition_json AS conditionJson
     FROM security_policies
     WHERE is_active = 1 AND rule_type = 'sla'`,
  );
  if (!policies.length) return { policies: 0, violationsCreated: 0 };

  let violationsCreated = 0;
  for (const policy of policies) {
    let condition = policy.conditionJson;
    if (typeof condition === 'string') {
      try { condition = JSON.parse(condition); } catch { condition = {}; }
    }
    const severity = String(condition?.severity || '').toLowerCase();
    const maxAgeHours = Number(condition?.maxAgeHours || 0);
    if (!severity || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) continue;

    const [rows] = await pool.query(
      `SELECT f.id AS findingId
       FROM project_findings f
       WHERE f.project_id = ?
         AND f.status = 'open'
         AND f.severity = ?
         AND f.created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? HOUR)`,
      [policy.projectId, severity, maxAgeHours],
    );

    for (const r of rows) {
      const [res] = await pool.execute(
        `INSERT IGNORE INTO sla_violations
          (id, policy_id, project_id, finding_id, severity, due_hours, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [uuidv4(), policy.id, policy.projectId, r.findingId, severity, maxAgeHours],
      );
      violationsCreated += Number(res?.affectedRows || 0);
    }
  }

  return { policies: policies.length, violationsCreated };
}
