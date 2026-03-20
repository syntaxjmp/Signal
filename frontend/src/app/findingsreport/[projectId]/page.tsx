"use client";

import React, { useEffect, useMemo, useState } from "react";
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

export default function FindingsReportPage() {
  const params = useParams<{ projectId: string }>();
  const search = useSearchParams();
  const { data: session, isPending } = authClient.useSession();
  const projectId = params.projectId;
  const scanId = search.get("scanId") || "";
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [payload, setPayload] = useState<FindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          window.setTimeout(() => setRefreshTick((t) => t + 1), 2000);
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

  const securityScoreRaw = payload?.summary?.securityScore ?? payload?.summary?.summary?.securityScore ?? null;
  const securityScore = securityScoreRaw == null ? null : Math.round(Number(securityScoreRaw));
  const scoreValue = Math.max(0, Math.min(50, Number(securityScore ?? 0)));
  const scorePercent = Number.isFinite(scoreValue) ? (scoreValue / 50) * 100 : 0;
  const scoreDelta = Math.round(securityScore ?? 0);
  const tone = scoreTone(securityScore);

  if (isPending) {
    return <main className={`report ${styles.root}`}>Checking session...</main>;
  }
  if (!session) {
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
        <Link href="/dashboard" className="report-brand" aria-label="Signal Findings">
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
        <Link href="/dashboard" className="report-btn report-btn--ghost">
          Back to dashboard
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
        {loading ? <div className="report-loading">Loading findings...</div> : null}

        {!loading && payload ? (
          <>
            <section className="report-topgrid">
              <div className="report-card">
                <div className="report-card__label">Security Score</div>
                <div
                  className={`report-gauge report-gauge--${tone}`}
                  style={{ ["--p" as any]: `${scorePercent}%` }}
                  aria-label={`Security score ${securityScore ?? "not scored"} out of 50`}
                >
                  <div className="report-gauge__inner">
                    <div className="report-gauge__value">{securityScore ?? "--"}</div>
                    <div className="report-gauge__denom">/ 50</div>
                  </div>
                </div>
                <div className="report-scoreMeta">
                  <div className="report-card__meta">{scoreLabel(securityScore)}</div>
                  <span className={scoreDelta > 0 ? "report-delta report-delta--down" : "report-delta report-delta--up"}>
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

              <div className="report-card">
                <div className="report-card__label">General Summary</div>
                <div className="report-summary">
                  Total findings: {payload.pagination.total} across {payload.summary?.scannedFilesCount ?? 0} scanned files.
                  {payload.summary?.status ? ` Latest scan status: ${payload.summary.status}.` : ""}
                </div>
              </div>
            </section>

            <section className="report-card">
              <div className="report-tableTitle">Vulnerabilities</div>
              {payload.data.length === 0 ? (
                <div className="report-empty">No findings for this scan.</div>
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
                      </tr>
                    </thead>
                    <tbody>
                      {payload.data.map((f) => (
                        <tr key={f.id}>
                          <td>
                            <span className={`sev sev--${f.severity}`}>{f.severity}</span>
                          </td>
                          <td>{f.category}</td>
                          <td>{f.description}</td>
                          <td className="report-mono">
                            {f.filePath}
                            {f.lineNumber ? `:${f.lineNumber}` : ""}
                          </td>
                          <td>{f.weightedScore}</td>
                        </tr>
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

