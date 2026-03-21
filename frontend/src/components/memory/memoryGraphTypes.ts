/** Shape expected by react-force-graph; plug real API data into this later. */
export type MemoryNodeGroup = "project" | "event" | "memory" | "finding" | "remediation" | "embedding";

export type MemoryGraphNode = {
  id: string;
  name: string;
  group: MemoryNodeGroup;
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
