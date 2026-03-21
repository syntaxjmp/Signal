import mysql from 'mysql2/promise';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './config/database.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool } from './config/database.js';
import { runSlaChecksOnce } from './services/slaAutomation.js';
import { pollFixOutcomes } from './services/fixOutcomeTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function maybeAutoMigrate() {
  if (!env.dbAutoMigrate || env.isProd) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

async function maybeEnsureProjectScansUserId() {
  // In this project, scans are written to `project_scans` and we want the Audit log UI
  // to show who ran each scan. Older DBs may not have `project_scans.user_id`.
  if (env.isProd) return;

  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    const [rows] = await conn.query(
      `
      SELECT COUNT(*) AS cnt
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'project_scans'
        AND column_name = 'user_id'
      `,
      [env.mysql.database],
    );

    const hasColumn = Number(rows?.[0]?.cnt || 0) > 0;
    if (!hasColumn) {
      await conn.query(`ALTER TABLE project_scans ADD COLUMN user_id VARCHAR(191) NULL`);
    }

    // Backfill for older scans so audit rows still have a "runner".
    await conn.query(`
      UPDATE project_scans ps
      JOIN projects p ON p.id = ps.project_id
      SET ps.user_id = p.user_id
      WHERE ps.user_id IS NULL
    `);
  } catch (e) {
    // Never prevent dev server boot due to an audit column mismatch.
    console.warn('[db:migrate] audit migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsureResolutionTables() {
  if (env.isProd) return;

  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    // Add status column to project_findings if missing
    const [statusRows] = await conn.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name = 'project_findings'
         AND column_name = 'status'`,
      [env.mysql.database],
    );
    if (Number(statusRows?.[0]?.cnt || 0) === 0) {
      await conn.query(
        `ALTER TABLE project_findings
         ADD COLUMN status ENUM('open', 'in_progress', 'resolved') NOT NULL DEFAULT 'open'`,
      );
    }

    // Create resolution_jobs table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS resolution_jobs (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
        finding_ids JSON NOT NULL,
        pr_url VARCHAR(1024) NULL,
        branch_name VARCHAR(255) NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_resolution_jobs_project (project_id),
        KEY idx_resolution_jobs_status (status),
        CONSTRAINT fk_resolution_jobs_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] resolution tables migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsureUserWebhookTable() {
  if (env.isProd) return;

  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_webhooks (
        id CHAR(36) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        webhook_url VARCHAR(2048) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_webhooks_user (user_id),
        KEY idx_user_webhooks_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] user_webhooks migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsureStatefulMemoryTables() {
  if (env.isProd) return;

  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS finding_dismissals (
        id CHAR(36) NOT NULL,
        fingerprint CHAR(64) NOT NULL,
        project_id CHAR(36) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        reason_code ENUM('false_positive', 'accepted_risk', 'mitigated_elsewhere', 'test_code', 'wont_fix') NOT NULL,
        justification TEXT NULL,
        scope ENUM('finding', 'project', 'org') NOT NULL DEFAULT 'finding',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_dismissals_project (project_id),
        KEY idx_dismissals_fp (fingerprint),
        KEY idx_dismissals_project_active (project_id, is_active),
        UNIQUE KEY uq_dismissals_project_fp_scope (project_id, fingerprint, scope),
        CONSTRAINT fk_dismissals_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS finding_regressions (
        id CHAR(36) NOT NULL,
        fingerprint CHAR(64) NOT NULL,
        project_id CHAR(36) NOT NULL,
        resolved_in_scan_id CHAR(36) NOT NULL,
        reappeared_in_scan_id CHAR(36) NOT NULL,
        original_finding_id CHAR(36) NULL,
        new_finding_id CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_regressions_project (project_id),
        KEY idx_regressions_fp (fingerprint),
        KEY idx_regressions_reappeared (reappeared_in_scan_id),
        UNIQUE KEY uq_regression_once_per_scan (project_id, fingerprint, reappeared_in_scan_id),
        CONSTRAINT fk_regressions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS scan_baselines (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        baseline_score DECIMAL(5,2) NOT NULL,
        baseline_finding_count INT UNSIGNED NOT NULL,
        score_stddev DECIMAL(6,3) NOT NULL DEFAULT 0,
        window_size INT UNSIGNED NOT NULL DEFAULT 10,
        last_recalculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_scan_baseline_project (project_id),
        CONSTRAINT fk_scan_baselines_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] stateful memory migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsurePolicyAndModelingTables() {
  if (env.isProd) return;
  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS security_policies (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        rule_type ENUM('sla', 'require_review', 'escalate') NOT NULL DEFAULT 'sla',
        condition_json JSON NOT NULL,
        action_json JSON NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by VARCHAR(191) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_security_policies_project (project_id),
        KEY idx_security_policies_active (is_active, rule_type),
        CONSTRAINT fk_security_policies_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sla_violations (
        id CHAR(36) NOT NULL,
        policy_id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        finding_id CHAR(36) NOT NULL,
        severity ENUM('critical', 'high', 'medium', 'low') NOT NULL,
        due_hours INT UNSIGNED NOT NULL,
        status ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sla_policy_finding (policy_id, finding_id),
        KEY idx_sla_violations_project (project_id),
        KEY idx_sla_violations_status (status),
        CONSTRAINT fk_sla_violations_policy FOREIGN KEY (policy_id) REFERENCES security_policies (id) ON DELETE CASCADE,
        CONSTRAINT fk_sla_violations_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
        CONSTRAINT fk_sla_violations_finding FOREIGN KEY (finding_id) REFERENCES project_findings (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS code_elements (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        scan_id CHAR(36) NOT NULL,
        element_type ENUM('route', 'middleware', 'handler', 'db_call', 'auth_check') NOT NULL,
        file_path VARCHAR(1024) NOT NULL,
        line_start INT UNSIGNED NULL,
        identifier VARCHAR(512) NULL,
        parent_element_id CHAR(36) NULL,
        metadata JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_code_elements_project_scan (project_id, scan_id),
        KEY idx_code_elements_type (element_type),
        CONSTRAINT fk_code_elements_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
        CONSTRAINT fk_code_elements_scan FOREIGN KEY (scan_id) REFERENCES project_scans (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] policy/modeling migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsurePhase1CompletionTables() {
  if (env.isProd) return;
  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS fix_outcomes (
        id CHAR(36) NOT NULL,
        resolution_job_id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        pr_url VARCHAR(1024) NOT NULL,
        pr_status ENUM('open', 'merged', 'closed') NOT NULL DEFAULT 'open',
        fix_category VARCHAR(255) NULL,
        fix_pattern_hash CHAR(64) NULL,
        files_changed INT UNSIGNED NOT NULL DEFAULT 0,
        review_comments_count INT UNSIGNED NOT NULL DEFAULT 0,
        merged_at TIMESTAMP NULL,
        closed_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fix_outcomes_project (project_id),
        KEY idx_fix_outcomes_status (pr_status),
        KEY idx_fix_outcomes_category (fix_category),
        CONSTRAINT fk_fix_outcomes_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
        CONSTRAINT fk_fix_outcomes_job FOREIGN KEY (resolution_job_id) REFERENCES resolution_jobs (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS developer_profiles (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        author_email VARCHAR(255) NOT NULL,
        author_name VARCHAR(255) NULL,
        total_findings_introduced INT UNSIGNED NOT NULL DEFAULT 0,
        critical_count INT UNSIGNED NOT NULL DEFAULT 0,
        high_count INT UNSIGNED NOT NULL DEFAULT 0,
        medium_count INT UNSIGNED NOT NULL DEFAULT 0,
        low_count INT UNSIGNED NOT NULL DEFAULT 0,
        top_categories JSON NULL,
        avg_fix_time_hours DECIMAL(10,2) NULL,
        risk_score DECIMAL(5,2) NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_dev_profiles_project_email (project_id, author_email),
        KEY idx_dev_profiles_risk (risk_score),
        CONSTRAINT fk_dev_profiles_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS developer_finding_links (
        id CHAR(36) NOT NULL,
        finding_id CHAR(36) NOT NULL,
        developer_profile_id CHAR(36) NOT NULL,
        commit_sha CHAR(40) NULL,
        blame_line INT UNSIGNED NULL,
        introduced_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_dev_finding_links_finding (finding_id),
        KEY idx_dev_finding_links_dev (developer_profile_id),
        CONSTRAINT fk_dev_finding_links_finding FOREIGN KEY (finding_id) REFERENCES project_findings (id) ON DELETE CASCADE,
        CONSTRAINT fk_dev_finding_links_dev FOREIGN KEY (developer_profile_id) REFERENCES developer_profiles (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS accepted_risks (
        id CHAR(36) NOT NULL,
        fingerprint CHAR(64) NOT NULL,
        project_id CHAR(36) NOT NULL,
        accepted_by VARCHAR(191) NOT NULL,
        reason TEXT NOT NULL,
        depends_on_files JSON NULL,
        depends_on_checksums JSON NULL,
        review_by_date DATE NULL,
        is_valid TINYINT(1) NOT NULL DEFAULT 1,
        invalidated_reason TEXT NULL,
        invalidated_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_accepted_risks_fingerprint (fingerprint),
        KEY idx_accepted_risks_project (project_id),
        KEY idx_accepted_risks_valid (is_valid, project_id),
        CONSTRAINT fk_accepted_risks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] phase1 completion tables migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsureComplianceFrameworksColumn() {
  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name = 'projects'
         AND column_name = 'compliance_frameworks'`,
      [env.mysql.database],
    );
    if (Number(rows?.[0]?.cnt || 0) === 0) {
      await conn.query(
        `ALTER TABLE projects ADD COLUMN compliance_frameworks JSON NULL COMMENT 'Selected framework ids for compliance scoring'`,
      );
    }
  } catch (e) {
    console.warn(
      '[db:migrate] compliance_frameworks column skipped',
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    await conn.end();
  }
}

function startFixOutcomePollingLoop() {
  const intervalMs = Math.max(60_000, Number(process.env.FIX_OUTCOME_INTERVAL_MS) || 30 * 60 * 1000);
  const run = async () => {
    try {
      const pool = getPool();
      const result = await pollFixOutcomes(pool);
      if (result.updated > 0) {
        console.info(`[fix-outcomes] updated ${result.updated} PR(s)`);
      }
    } catch (e) {
      console.warn('[fix-outcomes] polling run failed', e instanceof Error ? e.message : String(e));
    }
  };
  setTimeout(() => { void run(); }, 30_000).unref();
  setInterval(() => { void run(); }, intervalMs).unref();
}

function startSlaAutomationLoop() {
  const intervalMs = Math.max(60_000, Number(env.automation.slaIntervalMs) || 60 * 60 * 1000);
  const run = async () => {
    try {
      const pool = getPool();
      const result = await runSlaChecksOnce(pool);
      if (result.violationsCreated > 0) {
        console.info(`[sla] created ${result.violationsCreated} new violation(s)`);
      }
    } catch (e) {
      console.warn('[sla] automation run failed', e instanceof Error ? e.message : String(e));
    }
  };
  setTimeout(() => { void run(); }, 20_000).unref();
  setInterval(() => { void run(); }, intervalMs).unref();
}

async function main() {
  await maybeAutoMigrate();
  await maybeEnsureProjectScansUserId();
  await maybeEnsureResolutionTables();
  await maybeEnsureUserWebhookTable();
  await maybeEnsureStatefulMemoryTables();
  await maybeEnsurePolicyAndModelingTables();
  await maybeEnsurePhase1CompletionTables();
  await maybeEnsureComplianceFrameworksColumn();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`Signal API listening on port ${env.port} (${env.nodeEnv})`);
  });
  startSlaAutomationLoop();
  startFixOutcomePollingLoop();

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down…`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
