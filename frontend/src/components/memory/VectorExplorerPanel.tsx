"use client";

import { useCallback, useEffect, useState } from "react";
import type { VectorCollection, VectorPoint2D, VectorStatsResponse, VectorReduceResponse } from "./vectorTypes";
import styles from "./VectorExplorerPanel.module.css";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

const STATUS_COLORS: Record<string, string> = {
  merged: "#22c55e",
  open: "#3b82f6",
  closed: "#9ca3af",
};

const LANGUAGE_COLORS: Record<string, string> = {
  javascript: "#f7df1e",
  typescript: "#3178c6",
  python: "#3776ab",
  java: "#ed8b00",
  go: "#00add8",
  ruby: "#cc342d",
  php: "#777bb4",
  rust: "#dea584",
};

function getPointColor(payload: Record<string, unknown>, collectionName: string): string {
  if (collectionName.includes("finding")) {
    const sev = String(payload.severity || "");
    return SEVERITY_COLORS[sev] || "#ff7a52";
  }
  if (collectionName.includes("fix")) {
    const st = String(payload.pr_status || payload.prStatus || "");
    return STATUS_COLORS[st] || "#7ae8b8";
  }
  if (collectionName.includes("code_pattern")) {
    const lang = String(payload.language || "");
    return LANGUAGE_COLORS[lang] || "#c9a8ff";
  }
  return "#ff7a52";
}

function pointLabel(payload: Record<string, unknown>): string {
  if (payload.category) return String(payload.category);
  if (payload.fix_category) return String(payload.fix_category);
  if (payload.file_path) return String(payload.file_path).split("/").pop() || "";
  if (payload.vulnerability_category) return String(payload.vulnerability_category);
  return String(payload.id || "point");
}

function getColorMap(collectionName: string): Record<string, string> {
  if (collectionName.includes("finding")) return SEVERITY_COLORS;
  if (collectionName.includes("fix")) return STATUS_COLORS;
  if (collectionName.includes("code_pattern")) return LANGUAGE_COLORS;
  return {};
}

const PAD = 40;
const W = 600;
const H = 400;

function toSvg(px: number, py: number) {
  return {
    cx: PAD + ((px + 1) / 2) * (W - PAD * 2),
    cy: PAD + ((1 - (py + 1) / 2)) * (H - PAD * 2),
  };
}

type Props = {
  projectId?: string;
};

export default function VectorExplorerPanel({ projectId }: Props) {
  const [stats, setStats] = useState<VectorStatsResponse | null>(null);
  const [activeCollection, setActiveCollection] = useState<string>("");
  const [reduceData, setReduceData] = useState<VectorReduceResponse | null>(null);
  const [scatterLoading, setScatterLoading] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<VectorPoint2D | null>(null);
  const [neighborIds, setNeighborIds] = useState<Set<string>>(new Set());
  const [findingSimilar, setFindingSimilar] = useState(false);

  // Load collection stats
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/vector-stats`, { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((json: VectorStatsResponse) => {
        if (cancelled) return;
        setStats(json);
        if (json.collections?.length > 0 && !activeCollection) {
          setActiveCollection(json.collections[0].name);
        }
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load reduced vectors when collection changes
  useEffect(() => {
    if (!projectId || !activeCollection) return;
    let cancelled = false;
    setScatterLoading(true);
    setSelectedPoint(null);
    setNeighborIds(new Set());

    fetch(`/api/projects/${projectId}/vector-reduce?collection=${encodeURIComponent(activeCollection)}`, {
      credentials: "include",
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((json: VectorReduceResponse) => {
        if (!cancelled) setReduceData(json);
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        if (!cancelled) setScatterLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, activeCollection]);

  // Find Similar
  const handleFindSimilar = useCallback(async () => {
    if (!projectId || !selectedPoint) return;
    setFindingSimilar(true);
    try {
      const payload = selectedPoint.payload;
      const findingId = payload.finding_id || payload.id;
      if (!findingId) return;

      let endpoint = "similar-dismissed";
      if (activeCollection.includes("fix")) endpoint = "similar-fixes";
      else if (activeCollection.includes("code_pattern")) endpoint = "similar-patterns";

      const r = await fetch(
        `/api/projects/${projectId}/findings/${encodeURIComponent(String(findingId))}/${endpoint}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!r.ok) return;
      const json = await r.json();
      const similarIds = new Set<string>();
      const results = json.data || json;
      if (Array.isArray(results)) {
        for (const item of results) {
          if (item.payload?.finding_id) similarIds.add(String(item.payload.finding_id));
          if (item.payload?.id) similarIds.add(String(item.payload.id));
          if (item.id) similarIds.add(String(item.id));
        }
      }
      setNeighborIds(similarIds);
    } catch {
      // ignore
    } finally {
      setFindingSimilar(false);
    }
  }, [projectId, selectedPoint, activeCollection]);

  if (!projectId) {
    return <div className={styles.root}><div className={styles.empty}>Select a project to explore vectors</div></div>;
  }

  if (!stats) {
    return <div className={styles.root}><div className={styles.loading}>Loading vector stats...</div></div>;
  }

  if (!stats.enabled) {
    return <div className={styles.root}><div className={styles.empty}>Vector store is not enabled. Configure Qdrant to use this view.</div></div>;
  }

  const points = reduceData?.points || [];
  const colorMap = getColorMap(activeCollection);
  const payloadEntries = selectedPoint
    ? Object.entries(selectedPoint.payload).slice(0, 8)
    : [];

  return (
    <div className={styles.root}>
      {/* Collection pills */}
      <div className={styles.pillRow}>
        {stats.collections.map((col: VectorCollection) => (
          <button
            key={col.name}
            type="button"
            className={`${styles.pill} ${activeCollection === col.name ? styles.pillActive : ""}`}
            onClick={() => setActiveCollection(col.name)}
          >
            {col.name.replace(/_/g, " ")}
            <span className={styles.badge}>{col.pointsCount}</span>
          </button>
        ))}
      </div>

      {/* Scatter plot */}
      <div className={styles.scatterWrap}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className={styles.svg}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedPoint(null);
              setNeighborIds(new Set());
            }
          }}
        >
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {points.map((pt) => {
            const { cx, cy } = toSvg(pt.x, pt.y);
            const isSelected = selectedPoint?.id === pt.id;
            const isNeighbor = neighborIds.has(String(pt.id));
            if (isSelected || isNeighbor) return null;
            const color = getPointColor(pt.payload, activeCollection);
            return (
              <circle
                key={pt.id}
                cx={cx}
                cy={cy}
                r={4}
                fill={color}
                opacity={0.7}
                className={styles.point}
                onClick={() => setSelectedPoint(pt)}
              >
                <title>{pointLabel(pt.payload)}</title>
              </circle>
            );
          })}

          {/* Neighbor points with glow */}
          {points.filter((pt) => neighborIds.has(String(pt.id)) && selectedPoint?.id !== pt.id).map((pt) => {
            const { cx, cy } = toSvg(pt.x, pt.y);
            const color = getPointColor(pt.payload, activeCollection);
            return (
              <circle
                key={pt.id}
                cx={cx}
                cy={cy}
                r={5.5}
                fill={color}
                filter="url(#glow)"
                className={styles.point}
                onClick={() => setSelectedPoint(pt)}
              >
                <title>{pointLabel(pt.payload)}</title>
              </circle>
            );
          })}

          {/* Selected point on top */}
          {selectedPoint && (() => {
            const { cx, cy } = toSvg(selectedPoint.x, selectedPoint.y);
            return (
              <circle
                cx={cx}
                cy={cy}
                r={7}
                fill="#fff6f2"
                stroke="#ff7a52"
                strokeWidth={2}
              >
                <title>{pointLabel(selectedPoint.payload)}</title>
              </circle>
            );
          })()}
        </svg>

        {scatterLoading && <div className={styles.scatterLoading}>Loading embeddings...</div>}
        {!scatterLoading && points.length === 0 && (
          <div className={styles.scatterEmpty}>No embeddings in this collection for the current project</div>
        )}
      </div>

      {/* Color legend */}
      {Object.keys(colorMap).length > 0 && (
        <div className={styles.legend}>
          {Object.entries(colorMap).map(([label, color]) => (
            <span key={label} className={styles.legendItem}>
              <span className={styles.dot} style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Detail card */}
      {selectedPoint && (
        <div className={styles.detailCard}>
          <div className={styles.detailHeader}>
            <span className={styles.detailTitle}>{pointLabel(selectedPoint.payload)}</span>
            <button
              type="button"
              className={styles.detailClose}
              onClick={() => { setSelectedPoint(null); setNeighborIds(new Set()); }}
            >
              &times;
            </button>
          </div>
          <dl className={styles.detailGrid}>
            {payloadEntries.map(([key, value]) => (
              <div key={key} className={styles.detailRow}>
                <dt>{key}</dt>
                <dd>{String(value ?? "—")}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className={styles.findSimilarBtn}
            onClick={handleFindSimilar}
            disabled={findingSimilar}
          >
            {findingSimilar ? "Searching..." : "Find Similar"}
          </button>
          {neighborIds.size > 0 && (
            <span className={styles.neighborText}>{neighborIds.size} similar points highlighted</span>
          )}
        </div>
      )}
    </div>
  );
}
