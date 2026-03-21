import type { MemoryGraphData } from "./memoryGraphTypes";

/**
 * Placeholder graph: nodes ≈ entities in stateful memory (scans, baselines, dismissals, etc.).
 * Replace with API payload when wiring the memory service.
 */
export const DUMMY_MEMORY_GRAPH: MemoryGraphData = {
  nodes: [
    {
      id: "proj-main",
      name: "Project",
      group: "project",
      summary: "Root project context for Signal memory.",
      detail:
        "Anchors scans, embeddings, and remediation work. All other entities link back here for provenance when the memory service is fully wired.",
      meta: [
        { label: "Scope", value: "Repository + team" },
        { label: "Retention", value: "Project lifetime" },
      ],
      updatedAt: "2026-03-18",
    },
    {
      id: "scan-a",
      name: "Scan #42",
      group: "event",
      summary: "Completed security scan run.",
      detail: "Indexed files and produced findings that fed the baseline and embedding pipeline.",
      meta: [
        { label: "Status", value: "completed" },
        { label: "Files", value: "1.2k" },
      ],
      updatedAt: "2026-03-17T14:22Z",
    },
    {
      id: "scan-b",
      name: "Scan #43",
      group: "event",
      summary: "Follow-up scan after PR merges.",
      detail: "Used to verify fixes and refresh risk signals without a full cold start.",
      meta: [
        { label: "Status", value: "completed" },
        { label: "Delta", value: "vs #42" },
      ],
      updatedAt: "2026-03-19T09:05Z",
    },
    {
      id: "baseline-v1",
      name: "Baseline",
      group: "memory",
      summary: "Accepted risk snapshot for this repo.",
      detail: "Stores dismissed or accepted findings so regressions can be detected on later scans.",
      meta: [
        { label: "Version", value: "v1" },
        { label: "Source", value: "Scan #42" },
      ],
      updatedAt: "2026-03-17",
    },
    {
      id: "dismiss-x",
      name: "Dismissal",
      group: "memory",
      summary: "Recorded dismissal for a specific finding pattern.",
      detail: "Tied to policy; embeddings still capture semantic similarity for audits.",
      meta: [{ label: "Policy", value: "Waiver #7" }],
      updatedAt: "2026-03-16",
    },
    {
      id: "regress-1",
      name: "Regression",
      group: "event",
      summary: "Signal detected a reopened or new instance vs baseline.",
      detail: "Compared latest scan output to stored baseline hashes and severity tiers.",
      meta: [{ label: "Severity", value: "high" }],
      updatedAt: "2026-03-18T11:00Z",
    },
    {
      id: "find-sql",
      name: "Finding · SQL",
      group: "finding",
      summary: "SQL injection pattern in data layer.",
      detail: "Matched static rules and optional LLM triage when enabled. Linked to remediation PR when fixed.",
      meta: [
        { label: "Rule", value: "SQLI-01" },
        { label: "CWE", value: "CWE-89" },
      ],
      updatedAt: "2026-03-17",
    },
    {
      id: "find-xss",
      name: "Finding · XSS",
      group: "finding",
      summary: "Reflected XSS in user-controlled output.",
      detail: "Tracked through to PR #12 when marked resolved in Signal.",
      meta: [
        { label: "Rule", value: "XSS-REF-02" },
        { label: "CWE", value: "CWE-79" },
      ],
      updatedAt: "2026-03-18",
    },
    {
      id: "pr-12",
      name: "PR #12 fix",
      group: "remediation",
      summary: "Merged fix for XSS finding.",
      detail: "Remediation node closes the loop between finding status and Git workflow.",
      meta: [
        { label: "Branch", value: "fix/xss-ui" },
        { label: "Merged", value: "2026-03-18" },
      ],
      updatedAt: "2026-03-18",
    },
    {
      id: "emb-q",
      name: "Embedding cluster",
      group: "embedding",
      summary: "Vector cluster for semantic search / similarity.",
      detail: "Groups related code and finding text for retrieval-augmented workflows.",
      meta: [
        { label: "Model", value: "text-embedding-3-small" },
        { label: "Dims", value: "1536" },
      ],
      updatedAt: "2026-03-15",
    },
  ],
  links: [
    { source: "proj-main", target: "scan-a", kind: "derived" },
    { source: "proj-main", target: "scan-b", kind: "derived" },
    { source: "scan-a", target: "baseline-v1", kind: "derived" },
    { source: "scan-b", target: "baseline-v1", kind: "derived" },
    { source: "scan-a", target: "find-sql", kind: "derived" },
    { source: "scan-b", target: "find-xss", kind: "derived" },
    { source: "find-sql", target: "dismiss-x", kind: "caused" },
    { source: "baseline-v1", target: "regress-1", kind: "caused" },
    { source: "find-xss", target: "pr-12", kind: "resolved" },
    { source: "find-sql", target: "emb-q", kind: "indexed" },
    { source: "dismiss-x", target: "emb-q", kind: "indexed" },
  ],
};
