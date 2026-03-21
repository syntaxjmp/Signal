-- Signal — core schema for scanner backend
-- Run via: npm run db:migrate

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `findings`;
DROP TABLE IF EXISTS `scans`;
DROP TABLE IF EXISTS `codebase_artifacts`;
DROP TABLE IF EXISTS `vulnerability_check_types`;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE `vulnerability_check_types` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug` VARCHAR(96) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `group_key` VARCHAR(64) NOT NULL COMMENT 'e.g. injection, secrets, crypto',
  `default_severity` ENUM('critical', 'high', 'medium', 'low', 'info') NOT NULL DEFAULT 'medium',
  `cwe_id` INT UNSIGNED NULL COMMENT 'MITRE CWE id when applicable',
  `owasp_ref` VARCHAR(64) NULL COMMENT 'OWASP category or API top item reference',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vct_slug` (`slug`),
  KEY `idx_vct_group` (`group_key`),
  KEY `idx_vct_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `codebase_artifacts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `storage_key` VARCHAR(512) NOT NULL COMMENT 'Object store or disk path',
  `original_filename` VARCHAR(512) NULL,
  `content_sha256` CHAR(64) NOT NULL,
  `byte_size` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('uploaded', 'extracting', 'ready', 'failed') NOT NULL DEFAULT 'uploaded',
  `extracted_root_path` VARCHAR(1024) NULL COMMENT 'Working directory after extraction',
  `error_message` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_artifacts_status` (`status`),
  KEY `idx_artifacts_sha` (`content_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `scans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `artifact_id` BIGINT UNSIGNED NULL,
  `status` ENUM('pending', 'running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
  `scanner_version` VARCHAR(32) NULL,
  `scanned_files` JSON NOT NULL DEFAULT (JSON_ARRAY()) COMMENT 'JSON array of relative paths (or URIs) of files included in the scan',
  `files_scanned_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Denormalized count; should match length of scanned_files array',
  `started_at` TIMESTAMP NULL,
  `finished_at` TIMESTAMP NULL,
  `duration_ms` INT UNSIGNED NULL COMMENT 'Wall-clock time to complete scan',
  `summary` JSON NULL COMMENT 'Aggregates: counts by severity, top rules, etc.',
  `error_message` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_scans_artifact` (`artifact_id`),
  KEY `idx_scans_status` (`status`),
  KEY `idx_scans_created` (`created_at`),
  CONSTRAINT `fk_scans_artifact` FOREIGN KEY (`artifact_id`) REFERENCES `codebase_artifacts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `findings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scan_id` BIGINT UNSIGNED NOT NULL,
  `check_type_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(512) NOT NULL,
  `description` TEXT NULL,
  `severity` ENUM('critical', 'high', 'medium', 'low', 'info') NOT NULL,
  `confidence` DECIMAL(4, 3) NOT NULL DEFAULT 1.000 COMMENT '0–1 heuristic confidence',
  `file_path` VARCHAR(1024) NOT NULL,
  `line_start` INT UNSIGNED NULL,
  `line_end` INT UNSIGNED NULL,
  `column_start` INT UNSIGNED NULL,
  `snippet` MEDIUMTEXT NULL,
  `rule_id` VARCHAR(128) NULL COMMENT 'Internal rule / pattern id',
  `fingerprint` CHAR(64) NULL COMMENT 'Stable hash for deduplication within a scan',
  `metadata` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_findings_scan` (`scan_id`),
  KEY `idx_findings_type` (`check_type_id`),
  KEY `idx_findings_severity` (`severity`),
  CONSTRAINT `fk_findings_scan` FOREIGN KEY (`scan_id`) REFERENCES `scans` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_findings_check_type` FOREIGN KEY (`check_type_id`) REFERENCES `vulnerability_check_types` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `vulnerability_check_types`
  (`slug`, `name`, `description`, `group_key`, `default_severity`, `cwe_id`, `owasp_ref`) VALUES
  ('secret_generic', 'Hardcoded secret / credential', 'Possible password, token, or API key embedded in source or config.', 'secrets', 'critical', 798, NULL),
  ('secret_api_key', 'Exposed API key', 'Vendor-style API key pattern detected in repository.', 'secrets', 'critical', 798, NULL),
  ('secret_aws_key', 'AWS access key material', 'AWS-style access key id or long-lived secret pattern.', 'secrets', 'critical', 798, NULL),
  ('secret_private_key', 'Private key material', 'PEM or other private key block in repository.', 'secrets', 'critical', 321, NULL),
  ('sql_injection', 'SQL injection', 'User-controlled input concatenated or interpolated into SQL.', 'injection', 'high', 89, 'A03:2021 — Injection'),
  ('nosql_injection', 'NoSQL injection', 'Unsafe query construction against document/NoSQL stores.', 'injection', 'high', 943, 'A03:2021 — Injection'),
  ('command_injection', 'Command injection', 'Shell command built from untrusted input.', 'injection', 'critical', 78, 'A03:2021 — Injection'),
  ('ldap_injection', 'LDAP injection', 'LDAP filter or DN built from untrusted input.', 'injection', 'high', 90, 'A03:2021 — Injection'),
  ('xpath_injection', 'XPath injection', 'XPath built from untrusted input.', 'injection', 'high', 643, 'A03:2021 — Injection'),
  ('xss_reflected', 'Cross-site scripting (reflected)', 'Unescaped output leading to reflected XSS.', 'xss', 'high', 79, 'A03:2021 — Injection'),
  ('xss_stored', 'Cross-site scripting (stored)', 'Persisted content rendered without encoding.', 'xss', 'high', 79, 'A03:2021 — Injection'),
  ('xss_dom', 'DOM-based XSS', 'Client-side sinks writing untrusted data to DOM.', 'xss', 'medium', 79, 'A03:2021 — Injection'),
  ('path_traversal', 'Path traversal', 'Filesystem path built from untrusted input without canonicalization.', 'access_control', 'high', 22, 'A01:2021 — Broken Access Control'),
  ('open_redirect', 'Open redirect', 'Redirect target taken from user input without allowlist.', 'access_control', 'medium', 601, 'A01:2021 — Broken Access Control'),
  ('ssrf', 'Server-side request forgery', 'Outbound request URL or host influenced by user input.', 'ssrf', 'high', 918, 'A10:2021 — SSRF'),
  ('xxe', 'XML external entity', 'Unsafe XML parser configuration allowing external entities.', 'xxe', 'high', 611, 'A05:2021 — Security Misconfiguration'),
  ('insecure_deserialization', 'Insecure deserialization', 'Untrusted data deserialized into objects with dangerous gadgets.', 'deserialization', 'critical', 502, 'A08:2021 — Software and Data Integrity Failures'),
  ('weak_crypto', 'Weak cryptography', 'Deprecated algorithms (e.g. MD5, DES) or incorrect usage.', 'crypto', 'high', 327, 'A02:2021 — Cryptographic Failures'),
  ('hardcoded_crypto_key', 'Hardcoded cryptographic key', 'Encryption/signing key embedded in code or config.', 'crypto', 'critical', 321, 'A02:2021 — Cryptographic Failures'),
  ('insecure_randomness', 'Insecure randomness', 'Non-crypto PRNG used for security-sensitive values.', 'crypto', 'medium', 330, 'A02:2021 — Cryptographic Failures'),
  ('tls_misconfiguration', 'TLS / HTTPS misconfiguration', 'Weak protocols, bad cert validation, mixed content patterns in config.', 'transport', 'high', 295, 'A02:2021 — Cryptographic Failures'),
  ('sensitive_log_exposure', 'Sensitive data in logs', 'Secrets or PII may be written to logs.', 'data_exposure', 'medium', 532, 'A09:2021 — Security Logging and Monitoring Failures'),
  ('error_detail_leak', 'Verbose error / stack leak', 'Errors or traces exposed to clients.', 'data_exposure', 'medium', 209, 'A04:2021 — Insecure Design'),
  ('cors_misconfiguration', 'CORS misconfiguration', 'Overly permissive cross-origin policy.', 'config', 'medium', 942, 'A05:2021 — Security Misconfiguration'),
  ('insecure_cookie', 'Insecure cookie flags', 'Missing HttpOnly, Secure, or SameSite where needed.', 'session', 'medium', 614, 'A07:2021 — Identification and Authentication Failures'),
  ('session_fixation', 'Session fixation risk', 'Session id accepted from untrusted input or missing rotation.', 'session', 'medium', 384, 'A07:2021 — Identification and Authentication Failures'),
  ('mass_assignment', 'Mass assignment / unsafe binding', 'Request body bound directly to model without allowlist.', 'access_control', 'medium', 915, 'A04:2021 — Insecure Design'),
  ('idor', 'Insecure direct object reference', 'Object access without proper authorization checks (heuristic).', 'access_control', 'high', 639, 'API1:2023 — Broken Object Level Authorization'),
  ('eval_dynamic_code', 'Dangerous dynamic code execution', 'eval, Function constructor, or similar on untrusted data.', 'code_execution', 'critical', 94, 'A03:2021 — Injection'),
  ('unsafe_file_upload', 'Unsafe file upload', 'Upload path, type, or execution not restricted.', 'file_handling', 'high', 434, 'A04:2021 — Insecure Design'),
  ('dependency_vulnerable', 'Vulnerable dependency', 'Known CVE in lockfile / manifest (future integration).', 'supply_chain', 'high', NULL, 'A06:2021 — Vulnerable and Outdated Components'),
  ('regex_dos', 'Regular expression DoS', 'User-influenced regex vulnerable to catastrophic backtracking.', 'dos', 'medium', 1333, 'A04:2021 — Insecure Design'),
  ('prototype_pollution', 'Prototype pollution', 'Deep merge or object assignment from untrusted input (JS).', 'logic', 'high', 1321, NULL),
  ('race_condition', 'Race condition / TOCTOU', 'Time-of-check to time-of-use pattern in security-sensitive flow.', 'concurrency', 'medium', 367, NULL),
  ('missing_authz', 'Missing authorization check', 'Route or handler without explicit authz (heuristic).', 'access_control', 'high', 862, 'API5:2023 — Broken Function Level Authorization');

-- Project scanning pipeline tables
CREATE TABLE IF NOT EXISTS `projects` (
  `id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL COMMENT 'better-auth user id',
  `project_name` VARCHAR(255) NOT NULL,
  `github_url` VARCHAR(1024) NOT NULL,
  `description` TEXT NULL,
  `latest_scan_id` CHAR(36) NULL,
  `security_score` DECIMAL(5,2) NULL,
  `compliance_frameworks` JSON NULL COMMENT 'Selected framework ids for compliance scoring, e.g. ["soc2","owasp"]',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_projects_user` (`user_id`),
  KEY `idx_projects_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `project_scans` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NULL COMMENT 'better-auth user id',
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `findings_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `scanned_files_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `security_score` DECIMAL(5,2) NULL,
  `summary_json` JSON NULL,
  `error_message` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_scans_project` (`project_id`),
  KEY `idx_project_scans_user` (`user_id`),
  KEY `idx_project_scans_created` (`created_at`),
  CONSTRAINT `fk_project_scans_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `project_findings` (
  `id` CHAR(36) NOT NULL,
  `scan_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `severity` ENUM('critical', 'high', 'medium', 'low') NOT NULL,
  `category` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `line_number` INT UNSIGNED NULL,
  `weighted_score` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `file_path` VARCHAR(1024) NOT NULL,
  `snippet` MEDIUMTEXT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `status` ENUM('open', 'in_progress', 'resolved') NOT NULL DEFAULT 'open',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_project_findings_scan_fingerprint` (`scan_id`, `fingerprint`),
  KEY `idx_project_findings_project` (`project_id`),
  KEY `idx_project_findings_scan` (`scan_id`),
  KEY `idx_project_findings_project_scan` (`project_id`, `scan_id`),
  KEY `idx_project_findings_score` (`weighted_score`),
  KEY `idx_project_findings_status` (`status`),
  CONSTRAINT `fk_project_findings_scan` FOREIGN KEY (`scan_id`) REFERENCES `project_scans` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_project_findings_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `resolution_jobs` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `finding_ids` JSON NOT NULL COMMENT 'Array of finding IDs targeted by this job',
  `pr_url` VARCHAR(1024) NULL,
  `branch_name` VARCHAR(255) NULL,
  `error_message` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_resolution_jobs_project` (`project_id`),
  KEY `idx_resolution_jobs_user` (`user_id`),
  KEY `idx_resolution_jobs_status` (`status`),
  CONSTRAINT `fk_resolution_jobs_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_webhooks` (
  `id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `webhook_url` VARCHAR(2048) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_webhooks_user` (`user_id`),
  KEY `idx_user_webhooks_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stateful intelligence MVP (Phase 1 essentials)
CREATE TABLE IF NOT EXISTS `finding_dismissals` (
  `id` CHAR(36) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `reason_code` ENUM('false_positive', 'accepted_risk', 'mitigated_elsewhere', 'test_code', 'wont_fix') NOT NULL,
  `justification` TEXT NULL,
  `scope` ENUM('finding', 'project', 'org') NOT NULL DEFAULT 'finding',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dismissals_project` (`project_id`),
  KEY `idx_dismissals_fp` (`fingerprint`),
  KEY `idx_dismissals_project_active` (`project_id`, `is_active`),
  UNIQUE KEY `uq_dismissals_project_fp_scope` (`project_id`, `fingerprint`, `scope`),
  CONSTRAINT `fk_dismissals_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `finding_regressions` (
  `id` CHAR(36) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `resolved_in_scan_id` CHAR(36) NOT NULL,
  `reappeared_in_scan_id` CHAR(36) NOT NULL,
  `original_finding_id` CHAR(36) NULL,
  `new_finding_id` CHAR(36) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_regressions_project` (`project_id`),
  KEY `idx_regressions_fp` (`fingerprint`),
  KEY `idx_regressions_reappeared` (`reappeared_in_scan_id`),
  UNIQUE KEY `uq_regression_once_per_scan` (`project_id`, `fingerprint`, `reappeared_in_scan_id`),
  CONSTRAINT `fk_regressions_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scan_baselines` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `baseline_score` DECIMAL(5,2) NOT NULL,
  `baseline_finding_count` INT UNSIGNED NOT NULL,
  `score_stddev` DECIMAL(6,3) NOT NULL DEFAULT 0,
  `window_size` INT UNSIGNED NOT NULL DEFAULT 10,
  `last_recalculated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_scan_baseline_project` (`project_id`),
  CONSTRAINT `fk_scan_baselines_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `security_policies` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `rule_type` ENUM('sla', 'require_review', 'escalate') NOT NULL DEFAULT 'sla',
  `condition_json` JSON NOT NULL,
  `action_json` JSON NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(191) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_security_policies_project` (`project_id`),
  KEY `idx_security_policies_active` (`is_active`, `rule_type`),
  CONSTRAINT `fk_security_policies_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sla_violations` (
  `id` CHAR(36) NOT NULL,
  `policy_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `finding_id` CHAR(36) NOT NULL,
  `severity` ENUM('critical', 'high', 'medium', 'low') NOT NULL,
  `due_hours` INT UNSIGNED NOT NULL,
  `status` ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sla_policy_finding` (`policy_id`, `finding_id`),
  KEY `idx_sla_violations_project` (`project_id`),
  KEY `idx_sla_violations_status` (`status`),
  CONSTRAINT `fk_sla_violations_policy` FOREIGN KEY (`policy_id`) REFERENCES `security_policies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sla_violations_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sla_violations_finding` FOREIGN KEY (`finding_id`) REFERENCES `project_findings` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 1 completion: fix outcomes, developer profiles, accepted risks
CREATE TABLE IF NOT EXISTS `fix_outcomes` (
  `id` CHAR(36) NOT NULL,
  `resolution_job_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `pr_url` VARCHAR(1024) NOT NULL,
  `pr_status` ENUM('open', 'merged', 'closed') NOT NULL DEFAULT 'open',
  `fix_category` VARCHAR(255) NULL COMMENT 'Primary vulnerability category fixed',
  `fix_pattern_hash` CHAR(64) NULL COMMENT 'Hash of the diff for pattern matching',
  `files_changed` INT UNSIGNED NOT NULL DEFAULT 0,
  `review_comments_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `merged_at` TIMESTAMP NULL,
  `closed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fix_outcomes_job` (`resolution_job_id`),
  KEY `idx_fix_outcomes_project` (`project_id`),
  KEY `idx_fix_outcomes_status` (`pr_status`),
  KEY `idx_fix_outcomes_category` (`fix_category`),
  CONSTRAINT `fk_fix_outcomes_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fix_outcomes_job` FOREIGN KEY (`resolution_job_id`) REFERENCES `resolution_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `developer_profiles` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `author_email` VARCHAR(255) NOT NULL,
  `author_name` VARCHAR(255) NULL,
  `total_findings_introduced` INT UNSIGNED NOT NULL DEFAULT 0,
  `critical_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `high_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `medium_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `low_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `top_categories` JSON NULL COMMENT 'Array of {category, count} sorted desc',
  `avg_fix_time_hours` DECIMAL(10,2) NULL,
  `risk_score` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `first_seen_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dev_profiles_project_email` (`project_id`, `author_email`),
  KEY `idx_dev_profiles_risk` (`risk_score`),
  CONSTRAINT `fk_dev_profiles_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `developer_finding_links` (
  `id` CHAR(36) NOT NULL,
  `finding_id` CHAR(36) NOT NULL,
  `developer_profile_id` CHAR(36) NOT NULL,
  `commit_sha` CHAR(40) NULL,
  `blame_line` INT UNSIGNED NULL,
  `introduced_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dev_finding_links_finding` (`finding_id`),
  KEY `idx_dev_finding_links_dev` (`developer_profile_id`),
  CONSTRAINT `fk_dev_finding_links_finding` FOREIGN KEY (`finding_id`) REFERENCES `project_findings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dev_finding_links_dev` FOREIGN KEY (`developer_profile_id`) REFERENCES `developer_profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `accepted_risks` (
  `id` CHAR(36) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `accepted_by` VARCHAR(191) NOT NULL,
  `reason` TEXT NOT NULL,
  `depends_on_files` JSON NULL COMMENT '["sanitizer.js", "middleware/auth.js"]',
  `depends_on_checksums` JSON NULL COMMENT '{"sanitizer.js": "abc123..."} - checksums at time of acceptance',
  `review_by_date` DATE NULL,
  `is_valid` TINYINT(1) NOT NULL DEFAULT 1,
  `invalidated_reason` TEXT NULL,
  `invalidated_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_accepted_risks_fp_project` (`fingerprint`, `project_id`),
  KEY `idx_accepted_risks_fingerprint` (`fingerprint`),
  KEY `idx_accepted_risks_project` (`project_id`),
  KEY `idx_accepted_risks_valid` (`is_valid`, `project_id`),
  CONSTRAINT `fk_accepted_risks_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `code_elements` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `scan_id` CHAR(36) NOT NULL,
  `element_type` ENUM('route', 'middleware', 'handler', 'db_call', 'auth_check') NOT NULL,
  `file_path` VARCHAR(1024) NOT NULL,
  `line_start` INT UNSIGNED NULL,
  `identifier` VARCHAR(512) NULL,
  `parent_element_id` CHAR(36) NULL,
  `metadata` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_code_elements_project_scan` (`project_id`, `scan_id`),
  KEY `idx_code_elements_type` (`element_type`),
  CONSTRAINT `fk_code_elements_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_code_elements_scan` FOREIGN KEY (`scan_id`) REFERENCES `project_scans` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 3b: Attack chain detection
CREATE TABLE IF NOT EXISTS `attack_chains` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `scan_id` CHAR(36) NOT NULL,
  `chain_type` ENUM('unauth_data_access', 'unauth_injection', 'missing_auth_route', 'privilege_escalation', 'custom') NOT NULL,
  `entry_element_id` CHAR(36) NULL COMMENT 'Root route element',
  `severity` ENUM('critical', 'high', 'medium', 'low') NOT NULL,
  `escalated_from` ENUM('critical', 'high', 'medium', 'low') NULL COMMENT 'Original severity before escalation',
  `narrative` TEXT NULL,
  `hop_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `element_ids` JSON NOT NULL DEFAULT (JSON_ARRAY()),
  `finding_ids` JSON NOT NULL DEFAULT (JSON_ARRAY()),
  `metadata` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_attack_chains_project_scan` (`project_id`, `scan_id`),
  KEY `idx_attack_chains_type` (`chain_type`),
  KEY `idx_attack_chains_severity` (`severity`),
  CONSTRAINT `fk_attack_chains_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_attack_chains_scan` FOREIGN KEY (`scan_id`) REFERENCES `project_scans` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `element_finding_links` (
  `id` CHAR(36) NOT NULL,
  `element_id` CHAR(36) NOT NULL,
  `finding_id` CHAR(36) NOT NULL,
  `proximity_lines` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Absolute line distance between element and finding',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_element_finding_link` (`element_id`, `finding_id`),
  KEY `idx_element_finding_links_finding` (`finding_id`),
  CONSTRAINT `fk_element_finding_links_element` FOREIGN KEY (`element_id`) REFERENCES `code_elements` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_element_finding_links_finding` FOREIGN KEY (`finding_id`) REFERENCES `project_findings` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
