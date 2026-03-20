"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useParams, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import styles from "./page.module.css";

type Finding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  lineNumber?: number | null;
  weightedScore: number;
  filePath: string;
  snippet?: string | null;
  status?: "open" | "in_progress" | "resolved";
};

type FindingsResponse = {
  data: Finding[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: {
    id: string;
    status: string;
    findingsCount: number;
    scannedFilesCount: number;
    securityScore: number | null;
    summary: {
      severityCounts?: Record<string, number>;
      totalFindings?: number;
      totalWeightedScore?: number;
      rawTotalWeightedScore?: number;
      securityScore?: number;
    } | null;
    createdAt: string;
    finishedAt: string | null;
    prUrl?: string | null;
    prJobId?: string | null;
    prBranchName?: string | null;
  } | null;
};

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || "Unexpected server response" };
  }
}

function scoreLabel(score: number | null | undefined) {
  if (score == null) return "Not scored";
  if (score <= 10) return "Strong";
  if (score <= 25) return "Moderate";
  return "At risk";
}

function scoreTone(score: number | null | undefined) {
  if (score == null) return "unknown";
  if (score <= 10) return "strong";
  if (score <= 25) return "warn";
  return "critical";
}

function showPrAlert(prUrl: string) {
  const message = [
    "Signal Bot Pull Request",
    "",
    "A pull request was created for this resolved finding.",
    "",
    `PR URL: ${prUrl}`,
    "",
    "What to do next:",
    "1) Open the PR and review all code changes.",
    "2) Run tests/CI to validate behavior and security fixes.",
    "3) Approve and merge when checks pass.",
    "4) Re-scan after merge to confirm risk reduction.",
  ].join("\n");
  window.alert(message);
}

function getFileBaseName(filePath: string) {
  const normalized = String(filePath).replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function getFileIconSrc(filePath: string) {
  const base = getFileBaseName(filePath).toLowerCase();
  if (base.endsWith(".py")) return "/python.png";
  if (base.endsWith(".rs") || base === "cargo.toml") return "/rust.png";
  if (base.endsWith(".js") || base.endsWith(".ts") || base.endsWith(".tsx") || base.endsWith(".jsx")) return "/js.png";
  if (base === "dockerfile" || base.endsWith("/dockerfile")) return "/docker.png";
  return null;
}

/** Smooth HSL color from green (score 0) → yellow → red (score 50) */
function scoreHslColor(score: number | null | undefined): string {
  if (score == null) return "rgba(255, 230, 220, 0.55)";
  const clamped = Math.max(0, Math.min(50, score));
  // hue 150 = green, hue 40 = yellow-amber, hue 0 = red
  const hue = 150 * (1 - clamped / 50);
  return `hsl(${Math.round(hue)}, 65%, 58%)`;
}

export default function FindingsReportPage() {
  const params = useParams<{ projectId: string }>();
  const search = useSearchParams();
  const [session, setSession] = useState<any | null>(null);
  const [isPending, setIsPending] = useState<boolean>(true);
  const projectId = params.projectId;
  const scanId = search.get("scanId") || "";
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [payload, setPayload] = useState<FindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);

  // --- Resolution state ---
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [resolveStatus, setResolveStatus] = useState<string | null>(null);
  const [resolvePrUrl, setResolvePrUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [togglingStatus, setTogglingStatus] = useState<string | null>(null);

  async function promptResolve(target: "all" | string) {
    setResolveStatus("starting");
    setResolveError(null);
    setResolvePrUrl(null);
    try {
      const url =
        target === "all"
          ? `/api/projects/${projectId}/resolve-all`
          : `/api/projects/${projectId}/findings/${target}/resolve`;
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await readApiResponse(r);
      if (!r.ok) throw new Error(json?.error || "Failed to start resolution");
      setActiveJobId(json.jobId);
      setResolveStatus("running");
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : "Resolution failed");
      setResolveStatus(null);
    }
  }

  // Poll resolution job
  useEffect(() => {
    if (!activeJobId || !projectId) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/api/projects/${projectId}/resolution-jobs/${activeJobId}`, {
          credentials: "include",
        });
        const json = await readApiResponse(r);
        if (cancelled) return;
        if (json.status === "completed") {
          setResolveStatus("completed");
          setResolvePrUrl(json.prUrl || null);
          setActiveJobId(null);
          setRefreshTick((t) => t + 1);
        } else if (json.status === "failed") {
          setResolveStatus("failed");
          setResolveError(json.errorMessage || "Resolution failed");
          setActiveJobId(null);
          setRefreshTick((t) => t + 1);
        } else {
          setTimeout(poll, 3000);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    }
    const t = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [activeJobId, projectId]);

  async function toggleFindingStatus(findingId: string, newStatus: "open" | "resolved") {
    setTogglingStatus(findingId);
    try {
      const r = await fetch(`/api/projects/${projectId}/findings/${findingId}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (r.ok) {
        setPayload((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            data: prev.data.map((f) => (f.id === findingId ? { ...f, status: newStatus } : f)),
          };
        });
      }
    } catch {
      // silent fail
    } finally {
      setTogglingStatus(null);
    }
  }

  useEffect(() => {
    // Fetch session once to avoid continuous polling pressure on MySQL.
    let cancelled = false;
    async function run() {
      setIsPending(true);
      try {
        const r = await (authClient as any).getSession?.();
        const nextSession = r?.data ?? r?.session ?? null;
        if (!cancelled) setSession(nextSession);
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setIsPending(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({
          page: String(page),
          pageSize: "25",
        });
        if (scanId) q.set("scanId", scanId);
        const r = await fetch(`/api/projects/${projectId}/findings?${q.toString()}`, {
          credentials: "include",
          cache: "no-store",
        });
        const json = await readApiResponse(r);
        if (!r.ok) throw new Error(json?.error || "Failed to load findings report");
        setPayload(json);
        if (json?.summary?.status === "running") {
          window.setTimeout(() => setRefreshTick((t) => t + 1), 4500);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load findings");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [projectId, scanId, page, refreshTick]);

  const severityCounts = useMemo(() => {
    const s = payload?.summary?.summary?.severityCounts || {};
    return {
      critical: Number(s.critical || 0),
      high: Number(s.high || 0),
      medium: Number(s.medium || 0),
      low: Number(s.low || 0),
    };
  }, [payload]);

  const fileBreakdown = useMemo(() => {
    if (!payload?.data?.length) return [];
    const map: Record<string, { count: number; path: string }> = {};
    for (const f of payload.data) {
      const name = getFileBaseName(f.filePath);
      if (!map[name]) map[name] = { count: 0, path: f.filePath };
      map[name].count += 1;
    }
    const rows = Object.entries(map).map(([file, v]) => ({ file, count: v.count, path: v.path }));
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [payload]);

  const fileMax = useMemo(() => Math.max(1, ...fileBreakdown.map((r) => r.count)), [fileBreakdown]);

  const securityScoreRaw = payload?.summary?.securityScore ?? payload?.summary?.summary?.securityScore ?? null;
  const findingsPrUrl = payload?.summary?.prUrl ?? resolvePrUrl ?? null;
  const securityScore = securityScoreRaw == null ? null : Math.round(Number(securityScoreRaw));
  const scoreValue = Math.max(0, Math.min(50, Number(securityScore ?? 0)));
  // Score 0 = full green ring (perfect health). Score > 0 = fill proportional to risk.
  const scorePercent = scoreValue === 0 ? 100 : Math.max(8, (scoreValue / 50) * 100);
  const scoreDelta = Math.round(securityScore ?? 0);
  const tone = scoreTone(securityScore);
  const gaugeColor = scoreHslColor(securityScore);
  const [displayedScore, setDisplayedScore] = useState<number>(0);

  // Animate gauge fill with JS so it works in every browser
  useEffect(() => {
    const el = gaugeRef.current;
    if (!el || loading || !payload) return;
    const target = scorePercent;
    const duration = 1000;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      el!.style.setProperty("--gauge-fill", `${eased * target}%`);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    el.style.setProperty("--gauge-fill", "0%");
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading, payload, scorePercent]);

  // Animate score number count-up
  useEffect(() => {
    if (loading || !payload) return;
    const target = securityScore ?? 0;
    const duration = 1000;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayedScore(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    setDisplayedScore(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading, payload, securityScore]);

  if (!isPending && !session) {
    return (
      <main className={`report ${styles.root}`}>
        <div className="report-card">
          <h1 className="report-title">Findings Report</h1>
          <p className="report-subtitle">Please log in to view scan results.</p>
          <Link href="/login" className="report-btn">
            Go to login
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className={`report ${styles.root}`}>
      <div className="report-topnav">
        <Link href="/" className="report-brand" aria-label="Signal home">
          <Image
            src="/signal_evenbigger.png"
            alt=""
            width={60}
            height={60}
            className="report-brand__logo"
            priority
            aria-hidden
          />
          <div className="report-brand__title" aria-hidden="true">
            <span className="report-brand__signal">Signal</span>
            <span className="report-brand__sep">/</span>
            <span className="report-brand__item">Findings</span>
          </div>
        </Link>
        <Link href="/" className="report-btn report-btn--ghost">
          Back to landing
        </Link>
      </div>

      <div className="report-shell">
        <header className="report-header">
          <div>
            <h1 className="report-title">Project Scan Results</h1>
            <p className="report-subtitle">
              Vulnerabilities are listed individually with severity, category, description, and file context.
            </p>
          </div>
        </header>

        {error ? <div className="report-error">{error}</div> : null}
        {loading ? (
          <div className="report-loading">
            <div className="report-loading__topgrid">
              <div className="report-loading__skel report-loading__skel--score" />
              <div className="report-loading__skel report-loading__skel--breakdown" />
              <div className="report-loading__skel report-loading__skel--summary" />
            </div>
            <div className="report-loading__skel report-loading__skel--table" />
          </div>
        ) : null}

        {!loading && payload ? (
          <>
            <section className="report-topgrid report-fadein">
              <div className="report-card">
                <div className="report-card__label">Security Score</div>
                <div
                  ref={gaugeRef}
                  className={`report-gauge report-gauge--${tone}`}
                  style={{
                    ["--gauge-fill" as any]: "0%",
                    ["--gauge-color" as any]: gaugeColor,
                  }}
                  aria-label={`Security score ${securityScore ?? "not scored"} out of 50`}
                >
                  <div className="report-gauge__inner">
                    <div className="report-gauge__value">{securityScore == null ? "--" : displayedScore}</div>
                    <div className="report-gauge__denom">/ 50</div>
                  </div>
                </div>
                <div className="report-scoreMeta">
                  <div className="report-card__meta">{scoreLabel(securityScore)}</div>
                  <span
                    className={scoreDelta > 0 ? "report-delta report-delta--down" : "report-delta report-delta--up"}
                    style={
                      scoreDelta > 0
                        ? { color: gaugeColor, borderColor: gaugeColor, background: `color-mix(in srgb, ${gaugeColor} 14%, transparent)` }
                        : undefined
                    }
                  >
                    {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta}
                  </span>
                </div>
              </div>

              <div className="report-card">
                <div className="report-card__label">Score Breakdown</div>
                <div className="report-bars">
                  <div className="report-bar report-bar--critical">Critical: {severityCounts.critical}</div>
                  <div className="report-bar report-bar--high">High: {severityCounts.high}</div>
                  <div className="report-bar report-bar--medium">Medium: {severityCounts.medium}</div>
                  <div className="report-bar report-bar--low">Low: {severityCounts.low}</div>
                </div>
              </div>

              <div className="report-card report-card--summary">
                <div className="report-card__label">General Summary</div>
                <div className="report-summary">
                  Total findings: {payload.pagination.total} across {payload.summary?.scannedFilesCount ?? 0} scanned files.
                  {payload.summary?.status && (
                    <div className="report-scanStatus">
                      Latest scan status: <span className={`report-scanStatus__value report-scanStatus--${payload.summary.status}`}>{payload.summary.status}</span>
                    </div>
                  )}
                </div>
                {fileBreakdown.length > 0 && (() => {
                  const n = fileBreakdown.length;
                  const scale = n <= 2 ? 1.6 : n <= 4 ? 1.25 : 1;
                  const barH = Math.round(14 * scale);
                  const gap = n <= 2 ? 0.55 : n <= 4 ? 0.42 : 0.32;
                  const nameFz = `${(0.72 * scale).toFixed(2)}rem`;
                  const countFz = `${(0.76 * scale).toFixed(2)}rem`;
                  const nameW = Math.round(110 * scale);
                  const countW = Math.round(30 * scale);
                  return (
                    <div className="report-catChart">
                      <div className="report-catChart__label" style={{ fontSize: `${(0.72 * scale).toFixed(2)}rem` }}>
                        Findings by File
                      </div>
                      <div className="report-catChart__rows" style={{ gap: `${gap}rem` }}>
                        {fileBreakdown.map((row) => {
                          const ratio = row.count / fileMax;
                          const hue = Math.round(120 * (1 - ratio));
                          return (
                            <div
                              key={row.file}
                              className="report-catChart__row"
                              style={{ gridTemplateColumns: `${nameW}px 1fr ${countW}px` }}
                            >
                              <span className="report-catChart__name" title={row.file} style={{ fontSize: nameFz }}>
                                {getFileIconSrc(row.path) && (
                                  <Image
                                    src={getFileIconSrc(row.path)!}
                                    alt=""
                                    width={Math.round(16 * scale)}
                                    height={Math.round(16 * scale)}
                                    className="report-catChart__icon"
                                    aria-hidden
                                  />
                                )}
                                {row.file}
                              </span>
                              <div className="report-catChart__track" style={{ height: `${barH}px`, borderRadius: `${barH / 2}px` }}>
                                <div
                                  className="report-catChart__fill"
                                  style={{
                                    width: `${ratio * 100}%`,
                                    borderRadius: `${barH / 2}px`,
                                    background: `linear-gradient(90deg, hsla(${hue}, 72%, 52%, 0.8), hsla(${hue}, 72%, 52%, 1))`,
                                    boxShadow: `0 0 8px hsla(${hue}, 72%, 52%, 0.35)`,
                                  }}
                                />
                              </div>
                              <span className="report-catChart__count" style={{ fontSize: countFz }}>{row.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </section>

            {/* Resolution status banner */}
            {resolveStatus === "running" || resolveStatus === "starting" ? (
              <div className="report-resolve-banner report-resolve-banner--running report-fadein">
                <span className="report-resolve-spinner" />
                Resolving vulnerabilities — this may take a minute…
              </div>
            ) : null}
            {resolveStatus === "completed" && resolvePrUrl ? (
              <div className="report-resolve-banner report-resolve-banner--success report-fadein">
                PR created successfully!{" "}
                <a href={resolvePrUrl} target="_blank" rel="noopener noreferrer" className="report-resolve-link">
                  View Pull Request
                </a>
              </div>
            ) : null}
            {resolveStatus === "failed" && resolveError ? (
              <div className="report-resolve-banner report-resolve-banner--error report-fadein">
                Resolution failed: {resolveError}
              </div>
            ) : null}

            <section className="report-card report-fadein" style={{ animationDelay: "0.12s" }}>
              <div className="report-tableHeader">
                <div className="report-tableTitle">Vulnerabilities</div>
                {payload.data.some((f) => !f.status || f.status === "open") ? (
                  <button
                    className="report-btn report-btn--resolve"
                    onClick={() => promptResolve("all")}
                    disabled={resolveStatus === "running" || resolveStatus === "starting"}
                  >
                    Resolve All
                  </button>
                ) : null}
              </div>
              {payload.data.length === 0 ? (
                <div className="report-empty">No vulernabilites found, your codebase looks good!</div>
              ) : (
                <div className="report-tableWrap">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Category</th>
                        <th>Description</th>
                        <th>File</th>
                        <th>Score</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {payload.data.map((f) => (
                        (() => {
                          const fileBaseName = getFileBaseName(f.filePath);
                          const iconSrc = getFileIconSrc(f.filePath);
                          const fStatus = f.status || "open";
                          return (
                            <tr key={f.id} className={fStatus === "resolved" ? "report-row--resolved" : ""}>
                              <td>
                                <span className={`sev sev--${f.severity}`}>{f.severity}</span>
                              </td>
                              <td>{f.category}</td>
                              <td>{f.description}</td>
                              <td className="report-mono">
                                <div className="report-fileCell" title={f.filePath}>
                                  {iconSrc ? (
                                    <Image
                                      src={iconSrc}
                                      alt=""
                                      width={18}
                                      height={18}
                                      className="report-fileIcon"
                                      aria-hidden
                                    />
                                  ) : null}
                                  <span className="report-fileName">{fileBaseName}</span>
                                  {f.lineNumber != null ? <span className="report-fileLine">{`:${f.lineNumber}`}</span> : null}
                                </div>
                              </td>
                              <td>{f.weightedScore}</td>
                              <td>
                                <button
                                  className={`report-statusBadge report-statusBadge--${fStatus}`}
                                  disabled={togglingStatus === f.id}
                                  onClick={() =>
                                    toggleFindingStatus(f.id, fStatus === "resolved" ? "open" : "resolved")
                                  }
                                  title={fStatus === "resolved" ? "Click to reopen" : "Click to mark resolved"}
                                >
                                  {fStatus === "in_progress" ? "in progress" : fStatus}
                                </button>
                              </td>
                              <td className="report-resolveCell">
                                {fStatus === "open" ? (
                                  <button
                                    className="report-btn report-btn--sm report-btn--resolve"
                                    onClick={() => promptResolve(f.id)}
                                    disabled={resolveStatus === "running" || resolveStatus === "starting"}
                                  >
                                    Resolve
                                  </button>
                                ) : fStatus === "resolved" && findingsPrUrl ? (
                                  <button
                                    className="report-btn report-btn--sm report-btn--ghost"
                                    onClick={() => showPrAlert(findingsPrUrl)}
                                  >
                                    View
                                  </button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })()
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="report-pagination">
                <button
                  className="report-btn report-btn--ghost"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={payload.pagination.page <= 1}
                >
                  Previous
                </button>
                <span>
                  Page {payload.pagination.page} / {Math.max(1, payload.pagination.totalPages)}
                </span>
                <button
                  className="report-btn report-btn--ghost"
                  onClick={() => setPage((p) => Math.min(payload.pagination.totalPages || 1, p + 1))}
                  disabled={payload.pagination.page >= (payload.pagination.totalPages || 1)}
                >
                  Next
                </button>
              </div>
            </section>
          </>
        ) : null}
      </div>

    </main>
  );
}

