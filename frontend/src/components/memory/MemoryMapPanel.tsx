"use client";

import { useMemo, useRef, useState, useEffect } from "react";
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

const LINK_COLORS: Record<NonNullable<MemoryGraphData["links"][0]["kind"]>, string> = {
  derived: "rgba(255, 255, 255, 0.14)",
  caused: "rgba(255, 180, 120, 0.35)",
  resolved: "rgba(120, 232, 184, 0.45)",
  indexed: "rgba(200, 160, 255, 0.35)",
};

type Props = {
  /** Pass real graph data from the memory API later; defaults to dummy data. */
  graphData?: MemoryGraphData;
};

type ForceGraphInstance = InstanceType<typeof import("force-graph").default>;

export default function MemoryMapPanel({ graphData }: Props) {
  const data = graphData ?? DUMMY_MEMORY_GRAPH;
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphInstance | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

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
    return () => ro.disconnect();
  }, []);

  const fgData = useMemo(() => {
    return {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    };
  }, [data]);

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
        .nodeRelSize(5)
        .linkColor((l) => {
          const kind = (l as { kind?: MemoryGraphData["links"][0]["kind"] }).kind;
          return kind && LINK_COLORS[kind] ? LINK_COLORS[kind] : "rgba(255,255,255,0.12)";
        })
        .linkWidth(1.2)
        .cooldownTicks(120);

      fgRef.current = fg;
    })();

    return () => {
      cancelled = true;
      fgRef.current?._destructor();
      fgRef.current = null;
    };
  }, [dims.w, dims.h, fgData]);

  return (
    <div className={styles.root} aria-label="Memory map">
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
            Drag nodes to explore. Scroll or pinch zooms when enabled by the graph (if supported by your device).
          </p>
        </div>
      </div>
    </div>
  );
}
