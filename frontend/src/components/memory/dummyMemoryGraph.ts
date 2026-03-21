import type { MemoryGraphData } from "./memoryGraphTypes";

/**
 * Placeholder graph: nodes ≈ entities in stateful memory (scans, baselines, dismissals, etc.).
 * Replace with API payload when wiring the memory service.
 */
export const DUMMY_MEMORY_GRAPH: MemoryGraphData = {
  nodes: [
    { id: "proj-main", name: "Project", group: "project" },
    { id: "scan-a", name: "Scan #42", group: "event" },
    { id: "scan-b", name: "Scan #43", group: "event" },
    { id: "baseline-v1", name: "Baseline", group: "memory" },
    { id: "dismiss-x", name: "Dismissal", group: "memory" },
    { id: "regress-1", name: "Regression", group: "event" },
    { id: "find-sql", name: "Finding · SQL", group: "finding" },
    { id: "find-xss", name: "Finding · XSS", group: "finding" },
    { id: "pr-12", name: "PR #12 fix", group: "remediation" },
    { id: "emb-q", name: "Embedding cluster", group: "embedding" },
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
