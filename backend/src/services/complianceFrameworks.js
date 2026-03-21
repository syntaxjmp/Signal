/**
 * Maps static-scan findings to common compliance frameworks (heuristic; not a formal audit).
 * Scores are 0–100 per criterion; overall is the average of selected criteria in that framework.
 */

export const ALL_FRAMEWORK_IDS = ['soc2', 'owasp', 'gdpr', 'general'];

const SEV_PENALTY = { critical: 26, high: 16, medium: 8, low: 3 };

function penaltyForFinding(f) {
  return SEV_PENALTY[f.severity] ?? 3;
}

function haystackForFinding(f) {
  return `${f.category || ''} ${f.description || ''} ${f.filePath || ''}`.toLowerCase();
}

function scoreCriterion(findings, criterion) {
  const matches = findings.filter((f) => criterion.patterns.some((re) => re.test(haystackForFinding(f))));
  const unresolved = matches.filter((f) => f.status !== 'resolved');
  let penalty = 0;
  for (const f of unresolved) {
    penalty += penaltyForFinding(f);
  }
  const score = Math.max(0, Math.round(100 - Math.min(100, penalty)));
  return {
    id: criterion.id,
    label: criterion.label,
    score,
    matchedFindingCount: matches.length,
    unresolvedCount: unresolved.length,
  };
}

/**
 * Full catalog (for UI + API). Patterns are tuned to typical Signal categories/snippets.
 */
export const FRAMEWORK_DEFINITIONS = [
  {
    id: 'soc2',
    name: 'SOC 2 (Trust Service Criteria)',
    shortLabel: 'SOC 2',
    description:
      'Maps findings to common SOC 2–style themes: secrets handling, crypto, auth, access control, logging, and injection defenses.',
    criteria: [
      {
        id: 'soc2-secrets',
        label: 'Secrets, API keys, or credentials not hardcoded or logged',
        patterns: [
          /secret|api[_\-]?key|credential|password|token|hardcoded|private[_\-]?key|bearer|auth[_\-]?header/i,
          /log.*(?:password|secret|token|key)|console\.(?:log|debug).*secret/i,
        ],
      },
      {
        id: 'soc2-tls',
        label: 'Data encrypted in transit (HTTPS/TLS) and at rest where applicable',
        patterns: [
          /tls|ssl|https|encrypt|cipher|certificate|cert\.|at[_\-]?rest|kms|aes/i,
          /plaintext|unencrypted|disable.*tls|insecure.*transport/i,
        ],
      },
      {
        id: 'soc2-auth',
        label: 'Authentication and session management (no weak custom auth)',
        patterns: [
          /session|jwt|oauth|sso|mfa|authentication|login|cookie|csrf|same[_\-]?site/i,
          /rolling your own|custom auth|weak.*password/i,
        ],
      },
      {
        id: 'soc2-access',
        label: 'Access control enforced server-side (not client-only)',
        patterns: [
          /authorization|access control|rbac|permission|acl|missing[_\-]?auth|authz|privilege|role/i,
          /client[_\-]?side.*(?:only|check)/i,
        ],
      },
      {
        id: 'soc2-audit',
        label: 'Audit logs for sensitive operations (login, data access, admin)',
        patterns: [/audit|logging|log[_\-]?event|admin.*action|access[_\-]?log/i],
      },
      {
        id: 'soc2-injection',
        label: 'Input validation and output encoding (injection defenses)',
        patterns: [/injection|xss|sanitize|validate|escape|parameterized|prepared statement|nosql injection/i],
      },
    ],
  },
  {
    id: 'owasp',
    name: 'OWASP Top 10 (aligned themes)',
    shortLabel: 'OWASP',
    description: 'Broad alignment with OWASP Top 10 risk categories from codebase signals.',
    criteria: [
      {
        id: 'owasp-injection',
        label: 'Injection (SQL, NoSQL, command injection via unsanitised input)',
        patterns: [/injection|sql|nosql|command injection|exec\(|eval\(|shell|ldap injection/i],
      },
      {
        id: 'owasp-auth',
        label: 'Broken authentication (sessions, rate limiting, credentials)',
        patterns: [
          /session|brute|rate[_\-]?limit|credential|password|jwt|oauth|authentication|session fixation/i,
        ],
      },
      {
        id: 'owasp-sensitive',
        label: 'Sensitive data exposure (PII in logs, URLs, or error messages)',
        patterns: [/pii|personal data|ssn|email.*log|error message|stack trace|verbose.*error|expose/i],
      },
      {
        id: 'owasp-access',
        label: 'Broken access control (missing checks on routes or APIs)',
        patterns: [/access control|authorization|missing[_\-]?auth|horizontal|vertical|idor|bypass/i],
      },
      {
        id: 'owasp-misconfig',
        label: 'Security misconfiguration (debug, defaults, open CORS)',
        patterns: [/cors|debug|default.*password|misconfig|exposed|directory listing|verbose/i],
      },
      {
        id: 'owasp-deps',
        label: 'Vulnerable or outdated dependencies',
        patterns: [/depend|package|npm|pip|composer|vulnerab|outdated|cve|abandoned/i],
      },
      {
        id: 'owasp-idor',
        label: 'Insecure direct object references (IDs without ownership checks)',
        patterns: [/idor|direct object|object reference|predictable id|mass assignment/i],
      },
    ],
  },
  {
    id: 'gdpr',
    name: 'GDPR / data privacy',
    shortLabel: 'GDPR',
    description: 'Privacy-oriented signals: PII handling, retention, subprocessors, and consent.',
    criteria: [
      {
        id: 'gdpr-pii',
        label: 'PII not stored, logged, or transmitted unnecessarily',
        patterns: [
          /pii|personal data|gdpr|privacy|ip address|device id|email|consent|data subject/i,
        ],
      },
      {
        id: 'gdpr-retention',
        label: 'Data retention implications in storage logic',
        patterns: [/retention|ttl|expir|delete.*data|purge|archive|storage period/i],
      },
      {
        id: 'gdpr-third',
        label: 'Third-party services receiving user data flagged for review',
        patterns: [/third[_\-]?party|subprocessor|vendor|stripe|segment|analytics|sendgrid|twilio/i],
      },
      {
        id: 'gdpr-consent',
        label: 'Cookie / tracking logic consent-gated',
        patterns: [/cookie|tracking|consent|gdpr|banner|opt[_\-]?in|opt[_\-]?out|ccpa/i],
      },
    ],
  },
  {
    id: 'general',
    name: 'General secure coding',
    shortLabel: 'Secure coding',
    description: 'Baseline engineering hygiene: secrets, pinning, errors, rate limits, uploads.',
    criteria: [
      {
        id: 'gen-secrets',
        label: 'No secrets in source; env-based configuration documented',
        patterns: [/secret|env|\.env|credential|api[_\-]?key|hardcoded/i],
      },
      {
        id: 'gen-pin',
        label: 'Dependencies pinned to specific versions',
        patterns: [/depend|package\.json|requirements|lockfile|semver|pin|version range|\^|~/i],
      },
      {
        id: 'gen-errors',
        label: 'Errors do not expose stack traces or internal paths to clients',
        patterns: [/stack trace|internal path|verbose error|exception.*client|detail.*error/i],
      },
      {
        id: 'gen-rate',
        label: 'Rate limiting on public-facing endpoints',
        patterns: [/rate[_\-]?limit|throttl|429|brute|ddos|ip[_\-]?limit/i],
      },
      {
        id: 'gen-upload',
        label: 'File uploads validated (type, size, scanning)',
        patterns: [/upload|multipart|file type|mime|magic byte|virus|clamav|size limit/i],
      },
    ],
  },
];

/**
 * @param {string[] | null | undefined} ids — `null`/`undefined` = default (all frameworks). `[]` = explicit none.
 */
export function normalizeFrameworkIds(ids) {
  if (ids == null) return [...ALL_FRAMEWORK_IDS];
  if (!Array.isArray(ids)) return [...ALL_FRAMEWORK_IDS];
  const set = new Set();
  for (const id of ids) {
    const s = String(id).toLowerCase().trim();
    if (ALL_FRAMEWORK_IDS.includes(s)) set.add(s);
  }
  return [...set];
}

/**
 * @param {Array<{ severity: string, category: string, description: string, filePath: string, status: string }>} findings
 * @param {string[]} selectedFrameworkIds
 */
export function computeFrameworkScores(findings, selectedFrameworkIds) {
  const ids = normalizeFrameworkIds(selectedFrameworkIds);
  const list = [];
  for (const fw of FRAMEWORK_DEFINITIONS) {
    if (!ids.includes(fw.id)) continue;
    const criteria = fw.criteria.map((c) => scoreCriterion(findings, c));
    const overallScore =
      criteria.length === 0
        ? 100
        : Math.round(criteria.reduce((a, c) => a + c.score, 0) / criteria.length);
    list.push({
      frameworkId: fw.id,
      frameworkName: fw.name,
      shortLabel: fw.shortLabel,
      description: fw.description,
      overallScore,
      criteria,
    });
  }
  return list;
}

export function frameworkCatalogForClient() {
  return FRAMEWORK_DEFINITIONS.map((f) => ({
    id: f.id,
    name: f.name,
    shortLabel: f.shortLabel,
    description: f.description,
    criteria: f.criteria.map((c) => ({ id: c.id, label: c.label })),
  }));
}
