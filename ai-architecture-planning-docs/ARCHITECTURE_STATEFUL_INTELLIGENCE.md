# Signal — Stateful Security Intelligence Architecture

## Implementation Status Overview

> **Last audited: 2026-03-21**
>
> | Symbol | Meaning |
> |--------|---------|
> | **[DONE]** | Fully implemented in codebase |
> | **[PARTIAL]** | Partially implemented (some pieces missing) |
> | **[NOT DONE]** | Not yet implemented |
>
> **Overall: ~65-70% of this architecture is implemented.**
>
> | Phase | Status | Summary |
> |-------|--------|---------|
> | Phase 1: Stateful Foundation (MySQL) | **[DONE] ~100%** | All backend logic complete: dismissals, regressions, baselines, fix outcomes, developer profiles, accepted risks. Frontend UIs still partial. |
> | Phase 2: Vector Intelligence (Qdrant) | **[DONE] ~100%** | All 3 collections (finding, fix, code pattern embeddings) implemented. Contextual fix augmentation injects similar past fixes into resolution agent. API endpoints for similar-fixes and similar-patterns. |
> | Phase 3: Code Structure Graph | **[PARTIAL] ~40%** | Code element extraction done. Attack chain detection + combined analysis missing. |
> | Phase 4: Policy Engine & Org | **[PARTIAL] ~30%** | Policies + SLA tracking done. Organization model missing. |
> | Frontend UIs | **[PARTIAL] ~20%** | Most intelligence features are backend-only with no frontend UI yet. Compliance report is the exception. |
>
> **Features implemented but NOT listed in this doc:**
> - Compliance framework scoring (`complianceFrameworks.js`) — SOC 2, OWASP, GDPR alignment
> - Compliance report page with PDF export (`/compliance/[projectId]`)
> - AI-powered finding explanations (`explainFinding.js`)
> - SLA violations table (`sla_violations`) with tracking/resolution

---

## Problem Statement

Today, Signal is stateless. Every scan is independent. Findings are generated, stored, and displayed — but the system learns nothing from the history. A developer who dismisses the same false positive 10 times gets no relief. A team whose security score improved 60% over 3 months has no way to see that. An organization with the same vulnerability pattern across 30 repos can't detect the systemic issue.

This makes Signal replaceable by any CLI tool that calls an LLM.

The goal of this architecture is to turn Signal into a **compounding intelligence system** — one that gets measurably better with every scan, every dismissal, every fix, and every user interaction.

---

## Architecture Decision: Vector DB vs Knowledge Graph vs Relational

### The Three Options

| Storage | Best For | Weakness | Examples |
|---------|----------|----------|----------|
| **Relational (MySQL)** | Structured state, counters, timelines, policies, exact lookups | Can't do "find me something *similar* to this" | MySQL 8 (current) |
| **Vector DB** | Semantic similarity — "is this new finding *like* a dismissed one?" | No relationships, no traversal, no aggregation | Qdrant, Pinecone, pgvector |
| **Knowledge Graph** | Relationships & traversal — "trace the data flow from HTTP input to SQL query" | Overkill for simple state, complex ops, extra infrastructure | Neo4j, Amazon Neptune |

### What We Actually Need (And When)

#### Phase 1 — MySQL Only (Build Now)

Most of the stateful intelligence system is **structured, countable, and relational.** It doesn't need vectors or graphs.

| Feature | Why MySQL Works | Status |
|---------|----------------|--------|
| Finding lifecycle (open → dismissed → regressed) | Status enum + timestamps | **[DONE]** |
| Dismissal memory with justifications | New table, exact fingerprint match | **[DONE]** |
| Developer security profiles | JOIN git blame data with findings by author email | **[DONE]** |
| Security score trends over time | Already stored per scan, just query the timeline | **[DONE]** |
| Regression detection | Compare fingerprints between consecutive scans | **[DONE]** |
| Policy rules & SLA tracking | Config table + cron job for deadline checks | **[DONE]** |
| Fix success tracking (PR merged/closed) | Poll GitHub API, store outcome | **[DONE]** |
| Baseline calculation | AVG/STDDEV over recent scans per project | **[DONE]** |

**This covers ~70% of the value. No new infrastructure needed.**

#### Phase 2 — Add Vector Store (Build After Phase 1)

Vectors become necessary when we need **semantic similarity**, not exact matching.

| Feature | Why Vectors Are Needed | Status |
|---------|----------------------|--------|
| **Smart false-positive suppression** | User dismisses "Hardcoded password in config.js line 12". Next scan finds "Embedded credential in config.js line 14" — different fingerprint, same thing. Exact match fails. Vector similarity catches it. | **[DONE]** |
| **Similar fix lookup** | "A finding like this was resolved via PR #47 in another project. That fix used Knex query builder. Want to apply the same approach?" | **[DONE]** |
| **Code pattern recognition** | Embed code snippets, find snippets that are structurally similar to known-vulnerable patterns even when variable names differ. | **[DONE]** |

**Recommendation: Qdrant (self-hosted, open source, purpose-built for this)**

Why Qdrant over alternatives:
- **vs Pinecone**: Self-hosted = no vendor lock-in, no per-query pricing at scale. Pinecone is easier to start but expensive at volume.
- **vs pgvector**: Would require migrating from MySQL to PostgreSQL. Not worth it just for vectors. Keep MySQL for structured data + Qdrant for vectors.
- **vs ChromaDB**: Chroma is designed for prototyping/RAG. Qdrant has better filtering, production stability, and payload storage.
- **vs Weaviate**: Similar capability but Qdrant has a smaller footprint and simpler ops.

Embedding model: **OpenAI `text-embedding-3-small`** (1536 dimensions, cheap, fast). We're already paying for OpenAI API access. For code-specific embeddings, consider switching to **Voyage Code 3** or **Jina Code v2** later if similarity quality isn't good enough.

#### Phase 3 — Lightweight Graph Layer (Build After Phase 2)

For attack chain analysis, we need to model relationships between code elements:

```
HTTP Route "/api/users/:id"
  → calls handler getUserById()
    → calls db.query("SELECT * FROM users WHERE id = " + id)
      → SQL Injection (Finding #142)

HTTP Route "/api/admin/users"
  → no auth middleware attached
    → Missing Authorization (Finding #203)

Combined: Unauthenticated SQL injection via /api/admin/users
  → Attack Chain (Critical)
```

**Decision: Model this as adjacency tables in MySQL, NOT a separate graph database.**

Why:
- Signal's graph queries are simple (2-4 hops: route → middleware → handler → DB call)
- MySQL CTEs (WITH RECURSIVE) handle this fine at our scale
- Neo4j adds operational complexity (another DB to host, backup, monitor, keep in sync)
- If we outgrow MySQL's graph capabilities (>1M nodes, >10-hop traversals), migrate to Neo4j then

This means **no graph database in the initial architecture.** We model the code structure as relational tables with foreign keys, and use recursive CTEs for traversal.

---

## Data Architecture

### New MySQL Tables

```
┌─────────────────────────────────────────────────────────────────┐
│                     EXISTING TABLES                             │
│  projects, project_scans, project_findings, resolution_jobs,    │
│  vulnerability_check_types, user_webhooks                       │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  NEW: STATEFUL INTELLIGENCE                     │
│                                                                 │
│  ┌─────────────────────┐    ┌──────────────────────────┐        │
│  │ finding_dismissals   │    │ finding_regressions      │        │
│  │ [DONE - in schema]  │    │ [DONE - in schema]       │        │
│  │─────────────────────│    │──────────────────────────│        │
│  │ fingerprint (FK)     │    │ fingerprint              │        │
│  │ project_id           │    │ project_id               │        │
│  │ user_id              │    │ resolved_in_scan_id      │        │
│  │ reason_code          │    │ reappeared_in_scan_id    │        │
│  │ justification (text) │    │ original_finding_id      │        │
│  │ scope (project/org)  │    │ new_finding_id           │        │
│  │ depends_on_file      │    │ detected_at              │        │
│  │ created_at           │    └──────────────────────────┘        │
│  └─────────────────────┘                                        │
│                                                                 │
│  ┌─────────────────────┐    ┌──────────────────────────┐        │
│  │ developer_profiles   │    │ developer_finding_links  │        │
│  │ [DONE]               │    │ [DONE]                   │        │
│  │─────────────────────│    │──────────────────────────│        │
│  │ project_id           │    │ finding_id               │        │
│  │ author_email         │    │ developer_profile_id     │        │
│  │ author_name          │    │ commit_sha               │        │
│  │ total_findings       │    │ introduced_at            │        │
│  │ critical_count       │    │ blame_line               │        │
│  │ high_count           │    └──────────────────────────┘        │
│  │ top_categories (JSON)│                                       │
│  │ avg_fix_time_hours   │    ┌──────────────────────────┐        │
│  │ risk_score           │    │ scan_baselines           │        │
│  │ last_seen_at         │    │──────────────────────────│        │
│  └─────────────────────┘    │ project_id (UNIQUE)      │        │
│                              │ baseline_score           │        │
│  ┌─────────────────────┐    │ baseline_finding_count   │        │
│  │ security_policies    │    │ score_stddev             │        │
│  │ [DONE - in schema]  │    │ window_size (scans)      │        │
│  │─────────────────────│    │ [DONE - in schema]       │        │
│  │ org_id / project_id  │    │ last_recalculated_at    │        │
│  │ rule_type            │    └──────────────────────────┘        │
│  │ condition (JSON)     │                                       │
│  │ action (JSON)        │    ┌──────────────────────────┐        │
│  │ is_active            │    │ fix_outcomes             │        │
│  │ created_by           │    │ [DONE]                   │        │
│  └─────────────────────┘    │──────────────────────────│        │
│                              │ resolution_job_id        │        │
│                              │ pr_url                   │        │
│  ┌─────────────────────┐    │ pr_status (merged/closed)│        │
│  │ accepted_risks       │    │ merged_at / closed_at    │        │
│  │ [DONE]               │    │ fix_category             │        │
│  │─────────────────────│    │ fix_pattern_hash         │        │
│  │ fingerprint          │    │ review_comments_count   │        │
│  │ project_id           │    └──────────────────────────┘        │
│  │ accepted_by          │                                       │
│  │ reason               │                                       │
│  │ depends_on (JSON)    │    ┌──────────────────────────┐        │
│  │ review_by_date       │    │ code_elements            │        │
│  │ last_validated_at    │    │ [DONE - in schema]       │        │
│  └─────────────────────┘    │──────────────────────────│        │
│                              │ project_id               │        │
│                              │ scan_id                  │        │
│                              │ element_type (route,     │        │
│                              │   middleware, handler,    │        │
│                              │   db_call, auth_check)   │        │
│                              │ file_path                │        │
│                              │ line_start               │        │
│                              │ name / identifier        │        │
│                              │ parent_element_id (self) │        │
│                              │ metadata (JSON)          │        │
│                              └──────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Vector Store (Qdrant) Collections — **[DONE]** All 3 collections implemented

```
┌─────────────────────────────────────────────────────────────────┐
│                     QDRANT COLLECTIONS                          │
│                                                                 │
│  Collection: finding_embeddings  [DONE]                         │
│  ─────────────────────────────────────────────                  │
│  vector: embed(category + description + snippet)  [1536 dim]    │
│  payload: {                                                     │
│    fingerprint, project_id, org_id, severity,                   │
│    category, file_path, status,                                 │
│    dismissed: bool, dismiss_reason: string,                     │
│    fix_pattern_hash: string (if resolved via PR)                │
│  }                                                              │
│  Use cases:                                                     │
│    - "Is this new finding similar to a dismissed one?" (k=5)    │
│    - "Find findings across all org repos similar to this one"   │
│    - "What fix pattern was used for similar findings?"           │
│                                                                 │
│  Collection: code_pattern_embeddings  [DONE]                │
│  ─────────────────────────────────────────────                  │
│  vector: embed(normalized_code_snippet)           [1536 dim]    │
│  payload: {                                                     │
│    project_id, file_path, line_start, line_end,                 │
│    language, has_vulnerability: bool,                            │
│    vulnerability_category: string,                               │
│    is_safe_pattern: bool  (for known-good patterns)             │
│  }                                                              │
│  Use cases:                                                     │
│    - "This code looks like a pattern we've seen cause SQLi"     │
│    - "This code matches a known-safe parameterized query"       │
│    - Pre-filter before LLM to reduce false positives            │
│                                                                 │
│  Collection: fix_embeddings  [DONE]                         │
│  ─────────────────────────────────────────────                  │
│  vector: embed(finding_description + fix_diff)    [1536 dim]    │
│  payload: {                                                     │
│    category, language, framework,                               │
│    pr_merged: bool, fix_diff: string,                           │
│    project_id                                                   │
│  }                                                              │
│  Use cases:                                                     │
│    - "Show me fixes for similar issues that actually got merged" │
│    - Feed successful fix patterns into resolution agent prompt   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Intelligence Flows

### Flow 1: Smart Dismissal Memory — **[DONE]**

```
Developer dismisses Finding X
         │
         ▼
┌──────────────────────┐
│ Store in MySQL:       │
│  finding_dismissals   │
│  - fingerprint        │
│  - reason_code        │
│  - justification      │
│  - scope              │
│  - depends_on_file    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Embed in Qdrant:      │
│  finding_embeddings   │
│  - dismissed: true    │
│  - dismiss_reason     │
└──────────────────────┘

           ...later, during next scan...

New Finding Y detected
         │
         ▼
┌──────────────────────────────────────────┐
│ Step 1: Exact fingerprint match          │
│  SELECT * FROM finding_dismissals        │
│  WHERE fingerprint = Y.fingerprint       │
│  → If match: auto-suppress, done.        │
└──────────┬───────────────────────────────┘
           │ no exact match
           ▼
┌──────────────────────────────────────────┐
│ Step 2: Semantic similarity match        │
│  Qdrant search: embed(Y) → top 5        │
│  filter: dismissed = true                │
│  filter: project_id = Y.project_id       │
│  threshold: similarity > 0.92            │
│                                          │
│  → If match: flag as "likely duplicate   │
│    of dismissed finding", show user       │
│    with one-click confirm to suppress     │
│                                          │
│  → If no match: show as new finding      │
└──────────────────────────────────────────┘
```

Reason codes for dismissals:
- `false_positive` — scanner is wrong, this is not a vulnerability
- `accepted_risk` — real vulnerability, business decision to accept it
- `mitigated_elsewhere` — handled by WAF, middleware, etc. (links to depends_on_file)
- `test_code` — only exists in test/dev environment
- `wont_fix` — acknowledged, not worth fixing

### Flow 2: Regression Detection — **[DONE]**

```
Scan N completes → findings stored with fingerprints
         │
         ▼
┌────────────────────────────────────────────────┐
│ Compare fingerprints: Scan N vs Scan N-1        │
│                                                 │
│ Scan N-1 fingerprints:  {A, B, C, D, E}        │
│ Scan N   fingerprints:  {A, B, D, F, G}        │
│                                                 │
│ Removed (fixed):  {C, E}  → check if these     │
│   were previously open → mark as auto-resolved  │
│                                                 │
│ Added (new):  {F, G}  → new findings            │
│                                                 │
│ Persisted:  {A, B, D}  → unchanged              │
│                                                 │
│ REGRESSION CHECK:                               │
│ For each new fingerprint {F, G}:                │
│   Was this fingerprint ever in a prior scan     │
│   AND marked as resolved/dismissed?             │
│   → If yes: this is a REGRESSION               │
│   → Insert into finding_regressions table       │
│   → Alert: "Finding X was fixed in scan #N-3    │
│     but has reappeared"                         │
└────────────────────────────────────────────────┘
```

### Flow 3: Developer Security Profiles — **[DONE]**

```
Scan completes → new findings stored
         │
         ▼
┌────────────────────────────────────────────────┐
│ For each finding with a file_path + line_number │
│                                                 │
│ Git blame lookup (via GitHub API):              │
│   GET /repos/{owner}/{repo}/commits             │
│     ?path={file_path}&per_page=1                │
│   Or: parse blame from cloned repo              │
│                                                 │
│ Extract: author_email, author_name, commit_sha  │
│                                                 │
│ Insert into developer_finding_links:            │
│   finding_id, developer_profile_id,             │
│   commit_sha, introduced_at                     │
│                                                 │
│ Update developer_profiles:                      │
│   total_findings++                              │
│   critical_count++ (if severity = critical)     │
│   Recalculate top_categories                    │
│   Recalculate risk_score                        │
└────────────────────────────────────────────────┘

Developer Risk Score formula:
  risk = (critical × 10 + high × 5 + medium × 2 + low × 0.5)
         × recency_weight
         / total_commits_analyzed

  recency_weight: findings from last 30 days = 1.0,
                  60 days = 0.7, 90 days = 0.4, older = 0.2
```

### Flow 4: Contextual Fix Generation (Vector-Augmented) — **[DONE]**

```
User clicks "Resolve" on Finding X
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Step 1: Search Qdrant for similar past fixes      │
│                                                   │
│   Qdrant search: fix_embeddings collection        │
│   query: embed(X.category + X.description)        │
│   filter: pr_merged = true                        │
│   filter: language = project.language              │
│   top_k: 3                                        │
│                                                   │
│   Returns: 3 fix diffs that worked for similar    │
│   vulnerabilities in other projects               │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│ Step 2: Search codebase for existing utilities    │
│                                                   │
│   Grep project files for:                         │
│     - sanitize, validate, escape functions        │
│     - existing security middleware                │
│     - ORM/query builder usage patterns            │
│                                                   │
│   "This project already uses knex.js in 4 files.  │
│    Generate the fix using knex, not raw SQL."      │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│ Step 3: Augmented resolution prompt               │
│                                                   │
│   System: resolveAgentPrompt (existing)            │
│   + "Here are 3 similar fixes that were merged     │
│     successfully in other projects: ..."           │
│   + "This project uses knex.js for DB queries.     │
│     Use knex query builder, not parameterized      │
│     raw SQL."                                      │
│   + "Previous fix attempt for this category was    │
│     rejected (PR #47 closed). Reviewer comment:    │
│     'Don't add new dependencies.' Avoid adding     │
│     new imports."                                  │
│                                                   │
│   → LLM generates contextual fix                   │
└──────────────────────────────────────────────────┘
```

### Flow 5: Accepted Risk Invalidation — **[DONE]**

```
User accepts risk on Finding X:
  "eval() in template-engine.js is safe because
   input is sanitized in sanitizer.js"
         │
         ▼
┌──────────────────────────────────┐
│ Store in accepted_risks:          │
│   fingerprint: X.fingerprint      │
│   depends_on: ["sanitizer.js"]    │
│   reason: "input pre-validated"   │
│   accepted_by: user_id            │
│   review_by_date: +90 days        │
└──────────────────┬───────────────┘
                   │
    ...next scan...│
                   ▼
┌──────────────────────────────────────────────────┐
│ For each accepted risk with depends_on:            │
│                                                    │
│   Check: has the depends_on file changed since     │
│   the risk was accepted?                           │
│                                                    │
│   Git diff: sanitizer.js @ accepted_at             │
│         vs  sanitizer.js @ current scan            │
│                                                    │
│   If changed:                                      │
│     → Flag: "The safety assumption for accepted    │
│       risk on template-engine.js may be invalid.   │
│       sanitizer.js has been modified since this     │
│       risk was accepted. Please re-review."         │
│                                                    │
│   If review_by_date passed:                        │
│     → Flag: "Accepted risk is due for review.       │
│       Originally accepted by @user on 2025-12-01." │
└──────────────────────────────────────────────────┘
```

---

## System Architecture Diagram

```
                    ┌─────────────────────────────────┐
                    │          GitHub                   │
                    │  (repos, PRs, webhooks, blame)   │
                    └──────────┬──────────────────────┘
                               │
                    ┌──────────▼──────────────────────┐
                    │     Signal Backend (Express)     │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │     Scan Pipeline           │  │
                    │  │  clone → snippet → LLM →   │  │
                    │  │  dedupe → score → store     │  │
                    │  └─────────┬──────────────────┘  │
                    │            │                      │
                    │  ┌─────────▼──────────────────┐  │
                    │  │   Intelligence Engine       │  │
                    │  │                             │  │
                    │  │  - Regression detector      │  │
                    │  │  - Dismissal matcher        │  │
                    │  │  - Developer profiler       │  │
                    │  │  - Baseline calculator      │  │
                    │  │  - Risk invalidator         │  │
                    │  │  - Policy enforcer          │  │
                    │  └──┬──────────────┬──────────┘  │
                    │     │              │              │
                    └─────┼──────────────┼─────────────┘
                          │              │
              ┌───────────▼───┐   ┌──────▼────────────┐
              │   MySQL 8     │   │   Qdrant           │
              │               │   │   (Vector Store)   │
              │ - findings    │   │                    │
              │ - dismissals  │   │ - finding_embed    │
              │ - dev profiles│   │ - code_patterns    │
              │ - regressions │   │ - fix_embed        │
              │ - policies    │   │                    │
              │ - baselines   │   │                    │
              │ - code_elems  │   │                    │
              │ - fix_outcomes│   │                    │
              └───────────────┘   └───────────────────┘
```

---

## Implementation Phases

### Phase 1: Stateful Foundation (MySQL only, ~3-4 weeks) — **[DONE] ~100%**

No new infrastructure. Extend MySQL and backend logic.

**1a. Finding Lifecycle Tracking — [DONE]**
- ~~Add `finding_dismissals` table~~ Done — in `schema.sql`
- ~~Add dismiss/accept-risk endpoints to API~~ Done — `POST /projects/:id/findings/:findingId/dismiss`
- ~~On scan completion: compare fingerprints with previous scan → compute added/removed/regressed~~ Done — `statefulMemory.js`
- ~~Store regression events in `finding_regressions`~~ Done
- ~~API: `GET /projects/:id/findings/regressions`~~ Done — via `/memory-context` endpoint
- **Frontend UI: [NOT DONE]** — No dismissal form with reason codes in the frontend yet

**1b. Scan Baselines — [DONE]**
- ~~After each scan: recalculate rolling baseline (last 10 scans)~~ Done — `recomputeScanBaseline()`
- ~~Store in `scan_baselines`: avg score, stddev, avg finding count~~ Done
- ~~On scan completion: compare new score to baseline~~ Done
- If score deviates > 2 stddev: flag as anomaly — logic exists in baseline calc
- ~~API: `GET /projects/:id/baseline`~~ Done — via `/memory-context` endpoint
- **Frontend UI: [PARTIAL]** — Score delta shown in audit section, no long-term trend charts

**1c. Fix Outcome Tracking — [DONE]**
- ~~`fix_outcomes` table~~ Done — in `schema.sql` + auto-migration in `server.js`
- ~~Background job polling GitHub for PR merge/close status~~ Done — `fixOutcomeTracker.js` with `pollFixOutcomes()` on 30-min loop
- ~~Merge rate and fix stats API endpoint~~ Done — `GET /projects/:id/fix-outcomes`
- ~~Create fix_outcome on resolution job completion~~ Done — hooked into `resolutionAgent.js`

**1d. Regression Detection — [DONE]**
- ~~On scan completion: cross-reference new findings with all historical dismissals and resolved findings~~ Done — `detectAndStoreRegressions()`
- ~~If a previously-resolved fingerprint reappears: insert `finding_regressions` record~~ Done
- Webhook notification: not yet wired up to user_webhooks
- **Frontend UI: [NOT DONE]** — No dedicated regression alerts in the UI

**Database migration for Phase 1:**

> **Migration status:** `finding_dismissals` [DONE], `finding_regressions` [DONE], `scan_baselines` [DONE], `fix_outcomes` [DONE], `developer_profiles` [DONE], `developer_finding_links` [DONE], `accepted_risks` [DONE]

```sql
-- Finding dismissals [DONE - in schema.sql]
CREATE TABLE `finding_dismissals` (
  `id` CHAR(36) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `reason_code` ENUM('false_positive', 'accepted_risk', 'mitigated_elsewhere', 'test_code', 'wont_fix') NOT NULL,
  `justification` TEXT NULL,
  `scope` ENUM('finding', 'project', 'org') NOT NULL DEFAULT 'finding',
  `depends_on_files` JSON NULL COMMENT 'Files whose integrity this dismissal depends on',
  `review_by_date` DATE NULL COMMENT 'When this dismissal should be re-reviewed',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dismissals_fingerprint` (`fingerprint`),
  KEY `idx_dismissals_project` (`project_id`),
  KEY `idx_dismissals_active` (`is_active`, `project_id`),
  CONSTRAINT `fk_dismissals_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Finding regressions [DONE - in schema.sql]
CREATE TABLE `finding_regressions` (
  `id` CHAR(36) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `resolved_in_scan_id` CHAR(36) NOT NULL,
  `reappeared_in_scan_id` CHAR(36) NOT NULL,
  `original_finding_id` CHAR(36) NULL,
  `new_finding_id` CHAR(36) NULL,
  `acknowledged` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_regressions_project` (`project_id`),
  KEY `idx_regressions_fingerprint` (`fingerprint`),
  CONSTRAINT `fk_regressions_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Scan baselines [DONE - in schema.sql]
CREATE TABLE `scan_baselines` (
  `id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `baseline_score` DECIMAL(5,2) NOT NULL,
  `baseline_finding_count` INT UNSIGNED NOT NULL,
  `score_stddev` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `finding_count_stddev` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `window_size` INT UNSIGNED NOT NULL DEFAULT 10 COMMENT 'Number of scans in rolling window',
  `last_recalculated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_baselines_project` (`project_id`),
  CONSTRAINT `fk_baselines_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fix outcome tracking [DONE - in schema.sql]
CREATE TABLE `fix_outcomes` (
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
  KEY `idx_fix_outcomes_project` (`project_id`),
  KEY `idx_fix_outcomes_status` (`pr_status`),
  KEY `idx_fix_outcomes_category` (`fix_category`),
  CONSTRAINT `fk_fix_outcomes_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fix_outcomes_job` FOREIGN KEY (`resolution_job_id`) REFERENCES `resolution_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Developer profiles [DONE - in schema.sql]
CREATE TABLE `developer_profiles` (
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

-- Developer-to-finding link (blame data) [DONE - in schema.sql]
CREATE TABLE `developer_finding_links` (
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

-- Accepted risks with dependency tracking [DONE - in schema.sql]
CREATE TABLE `accepted_risks` (
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
  KEY `idx_accepted_risks_fingerprint` (`fingerprint`),
  KEY `idx_accepted_risks_project` (`project_id`),
  KEY `idx_accepted_risks_valid` (`is_valid`, `project_id`),
  CONSTRAINT `fk_accepted_risks_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Phase 2: Vector Intelligence (~2-3 weeks after Phase 1) — **[DONE] ~100%**

Add Qdrant. Requires one new service dependency.

**2a. Infrastructure — [DONE]**
- ~~Add Qdrant to docker-compose (or use Qdrant Cloud for hosted)~~ Done — Qdrant config via env vars
- ~~Create embedding service: `backend/src/services/embeddingService.js`~~ Done
- ~~Create Qdrant client wrapper: `backend/src/services/vectorStore.js`~~ Done

**2b. Finding Embeddings — [DONE]**
- ~~On scan completion: embed each finding (category + description + snippet) → store in Qdrant~~ Done — `upsertFindingEmbeddings()`
- ~~Include payload: fingerprint, project_id, org_id, severity, dismissed status~~ Done

**2c. Smart Dismissal Matching — [DONE]**
- ~~Before presenting findings to user: check each against dismissed finding embeddings~~ Done — `searchSimilarDismissedFindings()`
- ~~Similarity > 0.92: auto-suppress with "Previously dismissed (similar)" label~~ Done
- Similarity 0.85-0.92: show with "Similar to dismissed finding" hint + one-click dismiss — API exists (`GET /similar-dismissed`), **frontend UI: [NOT DONE]**

**2d. Contextual Fix Augmentation — [DONE]**
- ~~`fix_embeddings` collection created~~ Done — `vectorStore.js: ensureCollection()` + `upsertFixEmbedding()`
- ~~Resolution agent searches for similar past fixes~~ Done — `resolutionAgent.js: searchSimilarFixes()` called before fix generation
- ~~Historical fix context injected into prompts~~ Done — `buildSimilarFixContext()` appends merged fix examples to system prompt
- ~~`code_pattern_embeddings` collection~~ Done — `upsertCodePatternEmbeddings()` + `searchSimilarVulnerablePatterns()`
- ~~Fix embedding on PR merge~~ Done — `fixOutcomeTracker.js: embedMergedFix()` triggers when `pollFixOutcomes()` detects a merged PR
- API endpoints: `GET /projects/:id/findings/:findingId/similar-fixes`, `GET /projects/:id/findings/:findingId/similar-patterns`

**Docker Compose addition:**
```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"    # REST API
      - "6334:6334"    # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__GRPC_PORT: 6334

volumes:
  qdrant_data:
```

**Embedding service skeleton:**
```javascript
// backend/src/services/embeddingService.js
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

export async function embedText(client, text) {
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

export function buildFindingEmbeddingText(finding) {
  // Normalize the text to focus on semantic meaning, not syntax
  return [
    `Category: ${finding.category}`,
    `Severity: ${finding.severity}`,
    `Description: ${finding.description}`,
    finding.snippet ? `Code:\n${finding.snippet.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

export function buildFixEmbeddingText(finding, diff) {
  return [
    `Vulnerability: ${finding.category} - ${finding.description}`,
    `Fix diff:\n${diff.slice(0, 1000)}`,
  ].join('\n');
}
```

### Phase 3: Code Structure Graph (~3-4 weeks after Phase 2) — **[PARTIAL] ~40%**

Model code element relationships in MySQL adjacency tables.

**3a. Code Element Extraction — [DONE]**
- ~~During scan: extract routes, middleware, handlers, DB calls from AST or regex patterns~~ Done — `codeElementModeling.js`
- ~~Store in `code_elements` table with parent_element_id for hierarchy~~ Done — in schema.sql
- ~~Example: Route("/api/users/:id") → parent_of → Handler(getUserById) → parent_of → DBCall(query)~~ Done

**3b. Attack Chain Detection — [NOT DONE]**
- No graph traversal logic implemented
- No route-to-vulnerability path analysis
- No auth middleware gap detection along paths

**3c. Combined Finding Analysis — [NOT DONE]**
- No multi-finding correlation
- No attack chain narrative generation
- No severity escalation based on combined findings

**Code element extraction (regex-based, no AST required for MVP):**
```javascript
// Express route detection
// app.get('/api/users/:id', authMiddleware, getUserById)
const ROUTE_PATTERN = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Middleware usage detection
// router.use(authMiddleware)
const MIDDLEWARE_PATTERN = /\.use\s*\(\s*(\w+)/g;

// Raw SQL detection
// db.query("SELECT * FROM users WHERE id = " + id)
const DB_CALL_PATTERN = /\.(query|execute|raw)\s*\(/g;
```

### Phase 4: Policy Engine & Org Features (~3-4 weeks after Phase 3) — **[PARTIAL] ~30%**

**4a. Security Policies Table — [DONE]**
```sql
CREATE TABLE `security_policies` (
  `id` CHAR(36) NOT NULL,
  `org_id` VARCHAR(191) NULL COMMENT 'NULL = project-level policy',
  `project_id` CHAR(36) NULL COMMENT 'NULL = org-level policy',
  `name` VARCHAR(255) NOT NULL,
  `rule_type` ENUM('block_merge', 'require_review', 'auto_dismiss', 'escalate', 'sla') NOT NULL,
  `condition_json` JSON NOT NULL COMMENT '{"severity": "critical", "score_delta_gt": 5}',
  `action_json` JSON NOT NULL COMMENT '{"notify": "slack", "channel": "#security"}',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(191) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_policies_org` (`org_id`),
  KEY `idx_policies_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**4b. SLA Tracking — [DONE]**
- ~~Cron job runs hourly: check all open findings against policy SLAs~~ Done — `slaAutomation.js`, `runSlaChecksOnce()`, background loop in `server.js`
- ~~If finding age > SLA: trigger escalation action~~ Done — `sla_violations` table tracks violations
- **Frontend UI: [NOT DONE]** — No SLA violation dashboard in the frontend

**4c. Organization Model — [NOT DONE]**
- No `organizations` or `org_members` tables
- No org-level project grouping
- No org-level policy inheritance

---

## What NOT to Build

| Tempting Idea | Why Skip It |
|--------------|-------------|
| Custom AST parsing per language | Massive scope. Regex-based extraction is 80% as good. Revisit if customers demand it. |
| Real-time file watching | Scan-on-push via GitHub webhooks covers this. No need for file system watchers. |
| ML model fine-tuning on findings | Not enough data until 10K+ scans. Use prompt engineering + RAG (vectors) instead. |
| Full Neo4j integration | MySQL adjacency tables handle 2-4 hop traversals fine at current scale. |
| Multi-LLM routing | Premature optimization. Stick with one model, optimize prompts. |
| SARIF/SAST export format | Only build when a customer asks. Standard JSON API is fine for now. |

---

## Key Technical Decisions Summary

| Decision | Choice | Rationale | Implemented? |
|----------|--------|-----------|--------------|
| Primary database | MySQL 8 (keep existing) | Already in use, handles 70% of stateful needs, no migration cost | **[DONE]** |
| Vector store | Qdrant (self-hosted) | Open source, purpose-built, no vendor lock-in, good filtering | **[DONE]** |
| Embedding model | OpenAI text-embedding-3-small | Already have API access, 1536 dims, cheap ($0.02/1M tokens) | **[DONE]** |
| Graph database | None (MySQL adjacency tables) | Overkill at current scale, simple traversals only | **[DONE]** — table exists, traversal not built |
| Code analysis | Regex-based extraction | No AST dependency, works across languages, good enough for MVP | **[DONE]** |
| Background jobs | Node.js setTimeout / setInterval | Already in use for scans. Switch to BullMQ if queue complexity grows | **[DONE]** |
| Caching | None initially | Add Redis when response times demand it | **[DONE]** — still no caching, as planned |

---

## Success Metrics

How to know this is working:

| Metric | Target | How to Measure | Can Measure Today? |
|--------|--------|----------------|-------------------|
| False positive rate | Decrease 40% within 90 days of deployment | Count auto-suppressed findings / total findings per scan | **[PARTIAL]** — dismissals tracked, no auto-suppression metrics dashboard |
| Scan-over-scan accuracy | Fewer dismissed findings per scan over time | Track dismissal rate trend per project | **[PARTIAL]** — data exists, no trend UI |
| Fix merge rate | >70% of generated PRs get merged | fix_outcomes.pr_status = 'merged' / total | **[YES]** — fix_outcomes table + polling + merge rate API endpoint implemented |
| Regression detection rate | Catch 100% of reintroduced findings | finding_regressions count vs manual reports | **[YES]** — regression detection fully working |
| User retention signal | Users who see trend data retain 2x better | Cohort analysis: users with >5 scans vs users with 1-2 | **[NOT YET]** — no cohort analysis |
| Time to remediate | Decrease 30% within 6 months | Avg time from finding.created_at to status='resolved' | **[PARTIAL]** — timestamps exist, no reporting |
