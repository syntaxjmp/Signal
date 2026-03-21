"use client";

import Link from "next/link";
import Image from "next/image";
import { useParams } from "next/navigation";
import React, { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import styles from "./page.module.css";

type CompliancePayload = {
  ok?: boolean;
  error?: string;
  project?: {
    id: string;
    projectName: string;
    githubUrl: string;
    description?: string | null;
  };
  scan?: {
    id: string;
    finishedAt: string | null;
    securityScore: number | null;
    scannedFilesCount: number | null;
    findingsCount: number;
  } | null;
  executiveSummary?: {
    overallRisk: string;
    criticalIssues: number;
    highIssues: number;
    mediumIssues: number;
    lowIssues: number;
    criticalUnresolved: number;
    highUnresolved: number;
    statusLine: string;
    securityScore: number | null;
    scannedFiles: number | null;
  } | null;
  riskAreas?: Array<{ label: string; findingCount: number; exampleCategories: string[] }>;
  signalFixes?: {
    criticalResolvedPct: number;
    highResolvedPct: number;
    avgFixHours: number | null;
    criticalResolved: number;
    criticalTotal: number;
    highResolved: number;
    highTotal: number;
  } | null;
  strengths?: string[];
  verdict?: { headline: string; subtext: string; tone: string };
  timeline?: Array<{
    at: string;
    type: string;
    label: string;
    evidence?: { scanId?: string; prUrl?: string; jobId?: string };
  }>;
  evidence?: Array<{
    id: string;
    severity: string;
    category: string;
    title: string;
    impact: string;
    exploitPath: string;
    whatWasFixed: string;
    status: string;
    prUrl: string | null;
    filePath: string;
    lineNumber: number | null;
    createdAt: string;
  }>;
  emptyReason?: string | null;
};

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || "Unexpected server response" };
  }
}

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function sevClass(sev: string) {
  if (sev === "critical") return styles.sevCritical;
  if (sev === "high") return styles.sevHigh;
  if (sev === "medium") return styles.sevMedium;
  return styles.sevLow;
}

export default function ComplianceReportPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [session, setSession] = useState<unknown | null>(null);
  const [pending, setPending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CompliancePayload | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);

  async function downloadMarkdown() {
    if (!projectId || !session) return;
    setDownloadBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/compliance-report/export`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) {
        const json = (await readApiResponse(r)) as { error?: string };
        throw new Error(json.error || "Download failed");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition");
      let filename = `Signal-Compliance-${projectId}.md`;
      const quoted = cd && /filename="([^"]+)"/.exec(cd);
      const unquoted = cd && /filename=([^;\s]+)/.exec(cd);
      if (quoted?.[1]) filename = quoted[1];
      else if (unquoted?.[1]) filename = unquoted[1].replace(/^UTF-8''/i, "");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloadBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setPending(true);
      try {
        const r = await (authClient as { getSession?: () => Promise<unknown> }).getSession?.();
        const nextSession = (r as { data?: unknown })?.data ?? (r as { session?: unknown })?.session ?? null;
        if (!cancelled) setSession(nextSession);
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setPending(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId || pending || !session) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/projects/${projectId}/compliance-report`, {
          credentials: "include",
          cache: "no-store",
        });
        const json = (await readApiResponse(r)) as CompliancePayload;
        if (!r.ok) throw new Error((json as { error?: string }).error || "Failed to load compliance report");
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, pending, session]);

  if (!pending && !session) {
    return (
      <main className={styles.root}>
        <div className={styles.shell}>
          <h1 className={styles.title}>Compliance report</h1>
          <p className={styles.sub}>Please log in to view this report.</p>
          <Link href="/login" className={styles.back}>
            Go to login
          </Link>
        </div>
      </main>
    );
  }

  const es = data?.executiveSummary;
  const verdictClass =
    data?.verdict?.tone === "strong"
      ? `${styles.verdict} ${styles.verdictStrong}`
      : data?.verdict?.tone === "warn"
        ? `${styles.verdict} ${styles.verdictWarn}`
        : styles.verdict;

  return (
    <main
      className={`${styles.root} ${styles.watermark}`}
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 50% 0%, rgba(255, 90, 52, 0.14), transparent 46%), linear-gradient(180deg, #130704 0%, #1a0703 52%, #100402 100%)",
        color: "#f8f0ed",
      }}
    >
      <div className={styles.topnav}>
        <Link href="/" className={styles.brand} aria-label="Signal home">
          <Image src="/signal_evenbigger.png" alt="" width={44} height={44} priority />
          <span>Signal</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <span style={{ fontWeight: 650 }}>Compliance</span>
        </Link>
        <div className={styles.navActions}>
          <button
            type="button"
            className={styles.download}
            disabled={downloadBusy || pending || !session}
            onClick={() => void downloadMarkdown()}
          >
            {downloadBusy ? "Preparing…" : "Download report (.md)"}
          </button>
          <Link href="/dashboard" className={styles.back}>
            Dashboard
          </Link>
        </div>
      </div>

      <div className={styles.shell}>
        <h1 className={styles.title}>Compliance report</h1>
        <p className={styles.sub}>
          {data?.project?.projectName ? (
            <>
              <strong>{data.project.projectName}</strong>
              {data.project.githubUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={data.project.githubUrl} target="_blank" rel="noreferrer" className={styles.prLink}>
                    Repository
                  </a>
                </>
              ) : null}
            </>
          ) : (
            "Loading project…"
          )}
        </p>

        {error ? <div className={styles.error}>{error}</div> : null}
        {loading ? <div className={styles.loading}>Building report from scan data…</div> : null}

        {!loading && data?.emptyReason === "no_completed_scan" ? (
          <div className={styles.empty}>
            No completed scan yet. Run a scan from the dashboard, then return here for executive summary, risk areas,
            remediation stats, and evidence.
          </div>
        ) : null}

        {!loading && data && !data.emptyReason && es ? (
          <>
            <section className={styles.section} aria-labelledby="exec-heading">
              <div id="exec-heading" className={styles.sectionLabel}>
                1 · Executive summary (~10–15s read)
              </div>
              <div className={styles.execGrid}>
                <div className={styles.execCard}>
                  <div className={styles.execValue}>{es.overallRisk}</div>
                  <div className={styles.execKey}>Overall risk</div>
                </div>
                <div className={styles.execCard}>
                  <div className={styles.execValue}>{es.criticalIssues}</div>
                  <div className={styles.execKey}>Critical issues</div>
                </div>
                <div className={styles.execCard}>
                  <div className={styles.execValue}>{es.highIssues}</div>
                  <div className={styles.execKey}>High issues</div>
                </div>
                <div className={styles.execCard}>
                  <div className={styles.execValue}>{es.securityScore ?? "—"}</div>
                  <div className={styles.execKey}>Security score / 50</div>
                </div>
              </div>
              <div className={styles.execCardMuted} style={{ marginTop: "0.75rem" }}>
                <strong>Status:</strong> {es.statusLine}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="risk-heading">
              <div id="risk-heading" className={styles.sectionLabel}>
                2 · High-level risk areas
              </div>
              <p className={styles.sub} style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "0.95rem" }}>
                Issues grouped by theme (not every finding listed).
              </p>
              <div className={styles.riskList}>
                {(data.riskAreas ?? []).map((r) => (
                  <div key={r.label} className={styles.riskItem}>
                    <div className={styles.riskTitle}>{r.label}</div>
                    <div className={styles.riskMeta}>
                      {r.findingCount} finding{r.findingCount === 1 ? "" : "s"}
                      {r.exampleCategories?.length
                        ? ` · Examples: ${r.exampleCategories.slice(0, 3).join(", ")}`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {data.signalFixes ? (
              <section className={styles.section} aria-labelledby="fix-heading">
                <div id="fix-heading" className={styles.sectionLabel}>
                  3 · What Signal fixed (trust &amp; remediation)
                </div>
                <div className={styles.fixGrid}>
                  <div className={styles.fixCard}>
                    <div className={styles.fixPct}>{data.signalFixes.criticalResolvedPct}%</div>
                    <div className={styles.fixLabel}>
                      Critical resolved ({data.signalFixes.criticalResolved}/{data.signalFixes.criticalTotal})
                    </div>
                  </div>
                  <div className={`${styles.fixCard} ${styles.fixCardHighlight}`}>
                    <div className={styles.fixPct} style={{ color: "#ffc878" }}>
                      {data.signalFixes.highResolvedPct}%
                    </div>
                    <div className={styles.fixLabel}>
                      High resolved ({data.signalFixes.highResolved}/{data.signalFixes.highTotal})
                    </div>
                  </div>
                  <div className={styles.fixCard}>
                    <div className={styles.fixPct} style={{ color: "#a8d4ff", fontSize: "1.45rem" }}>
                      {data.signalFixes.avgFixHours != null ? `${data.signalFixes.avgFixHours}h` : "—"}
                    </div>
                    <div className={styles.fixLabel}>Avg. resolution job duration (PR workflows)</div>
                  </div>
                </div>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="str-heading">
              <div id="str-heading" className={styles.sectionLabel}>
                4 · Security strengths
              </div>
              <ul className={styles.strengthList}>
                {(data.strengths ?? []).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>

            {data.verdict ? (
              <section className={styles.section} aria-labelledby="verdict-heading">
                <div id="verdict-heading" className={styles.sectionLabel}>
                  5 · Final verdict
                </div>
                <div className={verdictClass}>
                  <h3>{data.verdict.headline}</h3>
                  <p>{data.verdict.subtext}</p>
                </div>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="tl-heading">
              <div id="tl-heading" className={styles.sectionLabel}>
                6 · Timeline &amp; evidence
              </div>
              <p className={styles.sub} style={{ marginTop: 0, marginBottom: "0.65rem", fontSize: "0.95rem" }}>
                Scan milestones and completed remediation jobs (PRs). Use alongside your change-management records.
              </p>
              <div className={styles.timeline}>
                {(data.timeline ?? []).map((t, i) => (
                  <div key={`${t.at}-${i}`} className={styles.tlRow}>
                    <div className={styles.tlDate}>{fmtWhen(t.at)}</div>
                    <div>
                      {t.label}
                      {t.evidence?.prUrl ? (
                        <>
                          {" "}
                          <a className={styles.prLink} href={t.evidence.prUrl} target="_blank" rel="noreferrer">
                            View PR
                          </a>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="ev-heading">
              <div id="ev-heading" className={styles.sectionLabel}>
                7 · Finding detail — impact, exploit path, fix
              </div>
              <div className={styles.evidence}>
                {(data.evidence ?? []).map((ev) => (
                  <article key={ev.id} className={styles.evCard}>
                    <div className={styles.evHead}>
                      <span className={`${styles.sev} ${sevClass(ev.severity)}`}>{ev.severity}</span>
                      <span className={styles.evTitle}>{ev.title}</span>
                    </div>
                    <dl className={styles.evBody}>
                      <dt>Impact</dt>
                      <dd>{ev.impact}</dd>
                      <dt>Exploit path</dt>
                      <dd>{ev.exploitPath}</dd>
                      <dt>What was fixed / status</dt>
                      <dd>
                        {ev.whatWasFixed}
                        {ev.prUrl ? (
                          <>
                            {" "}
                            <a className={styles.prLink} href={ev.prUrl} target="_blank" rel="noreferrer">
                              {ev.prUrl}
                            </a>
                          </>
                        ) : null}
                      </dd>
                      <div className={styles.fileRef}>
                        {ev.filePath}
                        {ev.lineNumber != null ? `:${ev.lineNumber}` : ""}
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
