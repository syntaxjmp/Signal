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
