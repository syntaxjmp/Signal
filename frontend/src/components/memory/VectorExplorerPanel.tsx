"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Camera state for pan/zoom
  const cameraRef = useRef({ offsetX: 0, offsetY: 0, scale: 1 });
  const dragRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);

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
    cameraRef.current = { offsetX: 0, offsetY: 0, scale: 1 };

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

  // Canvas rendering
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const points = reduceData?.points || [];
    if (points.length === 0) return;

    const cam = cameraRef.current;
    const pad = 40;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    function toScreen(px: number, py: number): [number, number] {
      const sx = pad + ((px + 1) / 2) * plotW;
      const sy = pad + ((1 - (py + 1) / 2)) * plotH;
      return [
        (sx - w / 2) * cam.scale + w / 2 + cam.offsetX,
        (sy - h / 2) * cam.scale + h / 2 + cam.offsetY,
      ];
    }

    const collection = activeCollection;

    // Draw points
    for (const pt of points) {
      const [sx, sy] = toScreen(pt.x, pt.y);
      const isSelected = selectedPoint?.id === pt.id;
      const isNeighbor = neighborIds.has(String(pt.id));
      const color = getPointColor(pt.payload, collection);
      const radius = isSelected ? 7 : isNeighbor ? 5.5 : 4;

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#fff6f2" : color;
      ctx.globalAlpha = isSelected || isNeighbor ? 1 : 0.7;
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = "#ff7a52";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (isNeighbor) {
        ctx.strokeStyle = "#7ec8ff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }, [reduceData, activeCollection, selectedPoint, neighborIds]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // ResizeObserver for canvas
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => drawCanvas());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [drawCanvas]);

  // Hit-test helper
  const hitTest = useCallback(
    (clientX: number, clientY: number): VectorPoint2D | null => {
      const canvas = canvasRef.current;
      if (!canvas || !reduceData?.points?.length) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const cam = cameraRef.current;
      const pad = 40;
      const plotW = w - pad * 2;
      const plotH = h - pad * 2;

      let closest: VectorPoint2D | null = null;
      let closestDist = 12; // click radius

      for (const pt of reduceData.points) {
        const sx = pad + ((pt.x + 1) / 2) * plotW;
        const sy = pad + ((1 - (pt.y + 1) / 2)) * plotH;
        const screenX = (sx - w / 2) * cam.scale + w / 2 + cam.offsetX;
        const screenY = (sy - h / 2) * cam.scale + h / 2 + cam.offsetY;
        const dist = Math.sqrt((mx - screenX) ** 2 + (my - screenY) ** 2);
        if (dist < closestDist) {
          closestDist = dist;
          closest = pt;
        }
      }
      return closest;
    },
    [reduceData],
  );

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      camX: cameraRef.current.offsetX,
      camY: cameraRef.current.offsetY,
    };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        cameraRef.current.offsetX = dragRef.current.camX + dx;
        cameraRef.current.offsetY = dragRef.current.camY + dy;
        drawCanvas();
        setTooltip(null);
        return;
      }
      // Hover tooltip
      const pt = hitTest(e.clientX, e.clientY);
      if (pt) {
        const rect = canvasRef.current!.getBoundingClientRect();
        setTooltip({
          x: e.clientX - rect.left + 12,
          y: e.clientY - rect.top - 8,
          text: pointLabel(pt.payload),
        });
      } else {
        setTooltip(null);
      }
    },
    [drawCanvas, hitTest],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const wasDrag =
        dragRef.current &&
        (Math.abs(e.clientX - dragRef.current.startX) > 3 ||
          Math.abs(e.clientY - dragRef.current.startY) > 3);
      dragRef.current = null;
      if (wasDrag) return;
      // Click
      const pt = hitTest(e.clientX, e.clientY);
      setSelectedPoint(pt);
      if (!pt) setNeighborIds(new Set());
    },
    [hitTest],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      cameraRef.current.scale = Math.max(0.3, Math.min(10, cameraRef.current.scale * delta));
      drawCanvas();
    },
    [drawCanvas],
  );

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

  return (
    <div className={styles.root}>
      {/* Collection stats bar */}
      <div className={styles.statsBar}>
        {stats.collections.map((col: VectorCollection) => (
          <div
            key={col.name}
            className={`${styles.collectionCard} ${activeCollection === col.name ? styles.collectionCardActive : ""}`}
            onClick={() => setActiveCollection(col.name)}
          >
            <span
              className={`${styles.statusDot} ${
                col.status === "green" ? styles.statusGreen : col.status === "not_found" ? styles.statusGray : styles.statusGreen
              }`}
            />
            <span className={styles.collectionName}>{col.name.replace(/_/g, " ")}</span>
            <span className={styles.collectionCount}>{col.pointsCount} pts</span>
          </div>
        ))}
      </div>

      {/* Main: scatter + sidebar */}
      <div className={styles.mainLayout}>
        <div className={styles.scatterWrap} ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { dragRef.current = null; setTooltip(null); }}
            onWheel={handleWheel}
          />
          {scatterLoading && <div className={styles.scatterLoading}>Loading embeddings...</div>}
          {!scatterLoading && (!reduceData?.points?.length) && (
            <div className={styles.scatterEmpty}>No embeddings in this collection for the current project</div>
          )}
          {tooltip && (
            <div className={styles.tooltip} style={{ left: tooltip.x, top: tooltip.y }}>
              {tooltip.text}
            </div>
          )}
        </div>

        <aside className={`${styles.sidebar} ${!selectedPoint ? styles.sidebarHidden : ""}`}>
          {selectedPoint && (
            <>
              <div className={styles.sidebarHeader}>
                <span className={styles.sidebarTitle}>Point Detail</span>
                <button
                  type="button"
                  className={styles.sidebarClose}
                  onClick={() => { setSelectedPoint(null); setNeighborIds(new Set()); }}
                >
                  x
                </button>
              </div>
              <div className={styles.payloadList}>
                {Object.entries(selectedPoint.payload).map(([key, value]) => (
                  <div key={key} className={styles.payloadRow}>
                    <span className={styles.payloadKey}>{key}</span>
                    <span className={styles.payloadValue}>{String(value ?? "—")}</span>
                  </div>
                ))}
                <div className={styles.payloadRow}>
                  <span className={styles.payloadKey}>x</span>
                  <span className={styles.payloadValue}>{selectedPoint.x}</span>
                </div>
                <div className={styles.payloadRow}>
                  <span className={styles.payloadKey}>y</span>
                  <span className={styles.payloadValue}>{selectedPoint.y}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.findSimilarBtn}
                onClick={handleFindSimilar}
                disabled={findingSimilar}
              >
                {findingSimilar ? "Searching..." : "Find Similar"}
              </button>
              {neighborIds.size > 0 && (
                <div className={styles.neighborDots}>
                  {Array.from(neighborIds).slice(0, 20).map((nid) => (
                    <span key={nid} className={styles.neighborDot} title={nid} />
                  ))}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
