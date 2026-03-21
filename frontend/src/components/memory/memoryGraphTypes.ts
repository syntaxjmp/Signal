/** Shape expected by react-force-graph; plug real API data into this later. */
export type MemoryNodeGroup = "project" | "event" | "memory" | "finding" | "remediation" | "embedding";

export type MemoryGraphNode = {
  id: string;
  name: string;
  group: MemoryNodeGroup;
  /** Short line shown in the detail panel. */
  summary?: string;
  /** Longer explanation / context. */
  detail?: string;
  /** Small key–value rows (status, refs, etc.). */
  meta?: { label: string; value: string }[];
  /** ISO or human-readable timestamp for display. */
  updatedAt?: string;
};

export type MemoryGraphLink = {
  source: string;
  target: string;
  kind?: "derived" | "caused" | "resolved" | "indexed";
};

export type MemoryGraphData = {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
};
