"use client";

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import type { MemoryGraphData, MemoryGraphNode } from "./memoryGraphTypes";
import { DUMMY_MEMORY_GRAPH } from "./dummyMemoryGraph";
import styles from "./MemoryMapPanel.module.css";

const GROUP_COLORS: Record<MemoryGraphNode["group"], string> = {
  project: "#ff7a52",
  event: "#7ec8ff",
  memory: "#c9a8ff",
  finding: "#ff8a8a",
  remediation: "#7ae8b8",
  embedding: "#ffd28a",
};

const GROUP_LABEL: Record<MemoryGraphNode["group"], string> = {
  project: "Project",
  event: "Event",
  memory: "Memory",
  finding: "Finding",
  remediation: "Remediation",
  embedding: "Embedding",
};

const LINK_COLORS: Record<NonNullable<MemoryGraphData["links"][0]["kind"]>, string> = {
  derived: "rgba(255, 255, 255, 0.14)",
  caused: "rgba(255, 180, 120, 0.35)",
  resolved: "rgba(120, 232, 184, 0.45)",
  indexed: "rgba(200, 160, 255, 0.35)",
};

const KIND_LABEL: Record<NonNullable<MemoryGraphData["links"][0]["kind"]>, string> = {
  derived: "derived",
  caused: "caused",
  resolved: "resolved",
  indexed: "indexed",
};

function linkEndpointId(end: string | { id?: string } | null | undefined): string | undefined {
  if (end == null) return undefined;
  if (typeof end === "string") return end;
  return end.id;
}

type Props = {
  /** Pass real graph data from the memory API later; defaults to dummy data. */
  graphData?: MemoryGraphData;
};

type ForceGraphInstance = InstanceType<typeof import("force-graph").default>;

export default function MemoryMapPanel({ graphData }: Props) {
  const data = graphData ?? DUMMY_MEMORY_GRAPH;
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphInstance | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  selectedIdRef.current = selectedId;

  const nodeById = useMemo(() => {
    const m = new Map<string, MemoryGraphNode>();
    for (const n of data.nodes) m.set(n.id, n);
    return m;
  }, [data.nodes]);

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;

  const neighbors = useMemo(() => {
    if (!selectedId) return { out: [] as { otherId: string; kind: string }[], in: [] as { otherId: string; kind: string }[] };
    const out: { otherId: string; kind: string }[] = [];
    const inn: { otherId: string; kind: string }[] = [];
    for (const l of data.links) {
      const k = l.kind ? KIND_LABEL[l.kind] : "link";
      if (l.source === selectedId) out.push({ otherId: l.target, kind: k });
      if (l.target === selectedId) inn.push({ otherId: l.source, kind: k });
    }
    return { out, in: inn };
  }, [data.links, selectedId]);

  useEffect(() => {
    setSelectedId(null);
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.floor(cr.width);
      const h = Math.floor(cr.height);
      if (w > 0 && h > 0) setDims((d) => (d.w === w && d.h === h ? d : { w, h }));
    });
    ro.observe(el);
    const w0 = Math.floor(el.clientWidth);
    const h0 = Math.floor(el.clientHeight);
    if (w0 > 0 && h0 > 0) setDims({ w: w0, h: h0 });
    return () => ro.disconnect();
  }, []);

  const fgData = useMemo(() => {
    return {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    };
  }, [data]);

  const applyHighlight = useCallback((fg: ForceGraphInstance, sel: string | null) => {
    fg
      .nodeColor((n) => {
        const node = n as MemoryGraphNode;
        const base = GROUP_COLORS[node.group] ?? "#aaa";
        if (sel === node.id) return "#fff6f2";
        return base;
      })
      .nodeVal((n) => ((n as MemoryGraphNode).id === sel ? 2.4 : 1))
      .linkColor((link) => {
        const l = link as {
          source: string | { id?: string };
          target: string | { id?: string };
          kind?: MemoryGraphData["links"][0]["kind"];
        };
        const sid = linkEndpointId(l.source);
        const tid = linkEndpointId(l.target);
        if (sel && (sid === sel || tid === sel)) return "rgba(255, 130, 95, 0.92)";
        const kind = l.kind;
        return kind && LINK_COLORS[kind] ? LINK_COLORS[kind] : "rgba(255,255,255,0.12)";
      })
      .linkWidth((link) => {
        const l = link as {
          source: string | { id?: string };
          target: string | { id?: string };
        };
        const sid = linkEndpointId(l.source);
        const tid = linkEndpointId(l.target);
        if (sel && (sid === sel || tid === sel)) return 2.6;
        return 1.2;
      });
    const g = fg.graphData();
    fg.graphData({ nodes: g.nodes, links: g.links });
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    applyHighlight(fg, selectedId);
  }, [selectedId, applyHighlight]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || dims.w <= 0 || dims.h <= 0) return;

    let cancelled = false;

    (async () => {
      const { default: ForceGraph } = await import("force-graph");
      if (cancelled || !containerRef.current) return;

      fgRef.current?._destructor();
      fgRef.current = null;

      const fg = new ForceGraph(containerRef.current)
        .width(dims.w)
        .height(dims.h)
        .backgroundColor("transparent")
        .graphData(fgData)
        .nodeId("id")
        .nodeLabel("name")
        .nodeColor((n) => GROUP_COLORS[(n as MemoryGraphNode).group] ?? "#aaa")
        .nodeVal(1)
        .nodeRelSize(5)
        .linkColor((l) => {
          const kind = (l as { kind?: MemoryGraphData["links"][0]["kind"] }).kind;
          return kind && LINK_COLORS[kind] ? LINK_COLORS[kind] : "rgba(255,255,255,0.12)";
        })
        .linkWidth(1.2)
        .cooldownTicks(120)
        .onNodeClick((node) => {
          setSelectedId((node as MemoryGraphNode).id);
        })
        .onBackgroundClick(() => {
          setSelectedId(null);
        });

      fgRef.current = fg;
      applyHighlight(fg, selectedIdRef.current);
    })();

    return () => {
      cancelled = true;
      fgRef.current?._destructor();
      fgRef.current = null;
    };
  }, [dims.w, dims.h, fgData, applyHighlight]);

  return (
    <div className={styles.root} aria-label="Memory map">
      <div className={styles.graphRow}>
        <div className={styles.graphColumn}>
          <div className={styles.graphStage}>
            <div ref={containerRef} className={styles.graphInner}>
              {dims.w <= 0 || dims.h <= 0 ? (
                <div className={styles.loading} role="status">
                  Preparing canvas…
                </div>
              ) : null}
            </div>

            <div className={styles.graphFooter}>
              <div className={styles.legend} aria-label="Node categories">
                {(Object.keys(GROUP_COLORS) as MemoryGraphNode["group"][]).map((g) => (
                  <span key={g} className={styles.legendItem}>
                    <span className={styles.dot} style={{ background: GROUP_COLORS[g] }} aria-hidden />
                    {g}
                  </span>
                ))}
              </div>
              <p className={styles.hint}>
                Click a node for details. Drag to rearrange. Scroll or pinch zooms when enabled (if supported by your
                device). Press Esc to clear selection.
              </p>
            </div>
          </div>
        </div>

        <aside className={styles.detailPanel} aria-live="polite">
          {selectedNode ? (
            <div className={styles.detailCard}>
              <div className={styles.detailHead}>
                <span
                  className={styles.detailGroup}
                  style={{
                    borderColor: GROUP_COLORS[selectedNode.group],
                    color: GROUP_COLORS[selectedNode.group],
                  }}
                >
                  {GROUP_LABEL[selectedNode.group]}
                </span>
                <button type="button" className={styles.detailClose} onClick={() => setSelectedId(null)} aria-label="Clear selection">
                  ×
                </button>
              </div>
              <h3 className={styles.detailTitle}>{selectedNode.name}</h3>
              {selectedNode.summary ? <p className={styles.detailSummary}>{selectedNode.summary}</p> : null}
              {selectedNode.detail ? <p className={styles.detailBody}>{selectedNode.detail}</p> : null}
              {selectedNode.meta && selectedNode.meta.length > 0 ? (
                <dl className={styles.metaList}>
                  {selectedNode.meta.map((row) => (
                    <div key={row.label} className={styles.metaRow}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {selectedNode.updatedAt ? (
                <p className={styles.detailUpdated}>
                  <span className={styles.detailUpdatedLabel}>Updated</span> {selectedNode.updatedAt}
                </p>
              ) : null}
              {(neighbors.out.length > 0 || neighbors.in.length > 0) && (
                <div className={styles.neighbors}>
                  {neighbors.out.length > 0 ? (
                    <div className={styles.neighborBlock}>
                      <div className={styles.neighborHeading}>Outgoing</div>
                      <ul className={styles.neighborList}>
                        {neighbors.out.map(({ otherId, kind }) => (
                          <li key={`o-${otherId}-${kind}`}>
                            <button
                              type="button"
                              className={styles.neighborBtn}
                              onClick={() => setSelectedId(otherId)}
                            >
                              {nodeById.get(otherId)?.name ?? otherId}
                            </button>
                            <span className={styles.neighborKind}>{kind}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {neighbors.in.length > 0 ? (
                    <div className={styles.neighborBlock}>
                      <div className={styles.neighborHeading}>Incoming</div>
                      <ul className={styles.neighborList}>
                        {neighbors.in.map(({ otherId, kind }) => (
                          <li key={`i-${otherId}-${kind}`}>
                            <button
                              type="button"
                              className={styles.neighborBtn}
                              onClick={() => setSelectedId(otherId)}
                            >
                              {nodeById.get(otherId)?.name ?? otherId}
                            </button>
                            <span className={styles.neighborKind}>{kind}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.detailEmpty}>
              <p className={styles.detailEmptyTitle}>Select a node</p>
              <p className={styles.detailEmptyText}>
                Click any circle in the graph to see a summary, metadata, and connections. Click the background to clear.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
