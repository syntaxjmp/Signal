"use client";

import Link from "next/link";
import Image from "next/image";
import { useParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  frameworkCatalog?: Array<{
    id: string;
    name: string;
    shortLabel: string;
    description: string;
    criteria: Array<{ id: string; label: string }>;
  }>;
  selectedFrameworkIds?: string[];
  frameworkScores?: Array<{
    frameworkId: string;
    frameworkName: string;
    shortLabel: string;
    description: string;
    overallScore: number;
    criteria: Array<{
      id: string;
      label: string;
      score: number;
      matchedFindingCount: number;
      unresolvedCount: number;
    }>;
  }>;
  frameworkDisclaimer?: string;
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

function ExecutiveSummaryVisuals({
  es,
  riskAreas,
}: {
  es: NonNullable<CompliancePayload["executiveSummary"]>;
  riskAreas: CompliancePayload["riskAreas"];
}) {
  const maxSev = Math.max(1, es.criticalIssues, es.highIssues, es.mediumIssues, es.lowIssues);
  const rows = [
    { label: "Critical", n: es.criticalIssues, fill: styles.execBarFillCritical },
    { label: "High", n: es.highIssues, fill: styles.execBarFillHigh },
    { label: "Medium", n: es.mediumIssues, fill: styles.execBarFillMedium },
    { label: "Low", n: es.lowIssues, fill: styles.execBarFillLow },
  ];
  const areas = riskAreas ?? [];
  const maxRisk = Math.max(1, ...areas.map((a) => a.findingCount));

  const totalFindings = es.criticalIssues + es.highIssues + es.mediumIssues + es.lowIssues;

  return (
    <div className={styles.execSummaryLayout}>
      <div className={styles.execChartBlock}>
        <div className={styles.execChartTitle}>Findings by severity</div>
        {rows.map((r) => (
          <div key={r.label} className={styles.execBarRow}>
            <span className={styles.execBarLabel}>{r.label}</span>
            <div className={styles.execBarTrack}>
              <div
                className={`${styles.execBarFill} ${r.fill}`}
                style={{ width: `${(r.n / maxSev) * 100}%` }}
              />
            </div>
            <span className={styles.execBarNum}>{r.n}</span>
          </div>
        ))}

        <div className={styles.execScoreBlock}>
          {totalFindings > 0 ? (
            <>
              <div className={styles.execChartTitle} style={{ marginBottom: "0.5rem" }}>
                Distribution (share of findings)
              </div>
              <div
                className={styles.execDistTrack}
                role="img"
                aria-label={`Severity mix: ${es.criticalIssues} critical, ${es.highIssues} high, ${es.mediumIssues} medium, ${es.lowIssues} low`}
              >
                {es.criticalIssues > 0 ? (
                  <div className={styles.execDistSeg} style={{ flex: es.criticalIssues, background: "#ff5b5b" }} />
                ) : null}
                {es.highIssues > 0 ? (
                  <div className={styles.execDistSeg} style={{ flex: es.highIssues, background: "#ff9b4a" }} />
                ) : null}
                {es.mediumIssues > 0 ? (
                  <div className={styles.execDistSeg} style={{ flex: es.mediumIssues, background: "#f5c84f" }} />
                ) : null}
                {es.lowIssues > 0 ? (
                  <div className={styles.execDistSeg} style={{ flex: es.lowIssues, background: "#7ec8ff" }} />
                ) : null}
              </div>
            </>
          ) : null}

          <div
            className={styles.execUnresolved}
            style={totalFindings > 0 ? { marginTop: "0.85rem" } : undefined}
          >
            <span className={styles.execChip}>Overall risk: {es.overallRisk}</span>
            <span className={styles.execChip}>Open critical: {es.criticalUnresolved}</span>
            <span className={styles.execChip}>Open high: {es.highUnresolved}</span>
          </div>
        </div>
      </div>

      <div className={styles.execHeatBlock}>
        <div className={styles.execHeatTitle}>Risk theme heatmap</div>
        {areas.length === 0 ? (
          <div className={styles.execHeatEmpty}>No grouped themes in this snapshot.</div>
        ) : (
          <div className={styles.execHeatGrid}>
            {areas.map((a) => {
              const t = maxRisk > 0 ? a.findingCount / maxRisk : 0;
              /* Neutral surface + soft edge; intensity = left accent only (no loud fill) */
              const bg = `rgba(255, 255, 255, ${0.018 + t * 0.038})`;
              const edge = `rgba(255, 255, 255, ${0.055 + t * 0.08})`;
              const accent = `rgba(255, 255, 255, ${0.14 + t * 0.32})`;
              return (
                <div
                  key={a.label}
                  className={styles.execHeatCell}
                  style={{
                    backgroundColor: bg,
                    border: `1px solid ${edge}`,
                    borderLeft: `3px solid ${accent}`,
                  }}
                  title={`${a.label}: ${a.findingCount}`}
                >
                  <span className={styles.execHeatLabel}>{a.label}</span>
                  <span className={styles.execHeatMeta}>
                    {a.findingCount} finding{a.findingCount === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const STEP_COLORS = {
  box: "#3F3D56",
  rose: "#D86D82",
};

function StepScoreIndicator({ score, compact }: { score: number; compact?: boolean }) {
  const steps = 10;
  const clamped = Math.min(100, Math.max(0, score));
  const filled = Math.min(steps, Math.max(0, Math.round(clamped / 10)));
  const decile = Math.min(10, Math.max(0, Math.round(clamped / 10)));
  const boxLabel = decile === 10 ? "10" : String(decile);
  const pct = Math.round(clamped);

  return (
    <div
      className={compact ? styles.stepWrapCompact : styles.stepWrap}
      title={`${pct}%`}
      role="img"
      aria-label={`${pct} percent`}
    >
      <div
        className={styles.stepBox}
        style={{ backgroundColor: STEP_COLORS.box }}
        aria-hidden
      >
        {boxLabel}
      </div>
      <div className={styles.stepRow}>
        {Array.from({ length: steps }, (_, i) => (
          <span
            key={i}
            className={i < filled ? styles.stepDotFilled : styles.stepDotEmpty}
            style={
              i < filled
                ? { backgroundColor: STEP_COLORS.rose, borderColor: STEP_COLORS.rose }
                : { borderColor: STEP_COLORS.rose }
            }
          />
        ))}
      </div>
    </div>
  );
}

function FrameworkAlignmentSection({
  catalog,
  selectedIds,
  scores,
  disclaimer,
  emptyScan,
  onToggle,
  variant,
}: {
  catalog: NonNullable<CompliancePayload["frameworkCatalog"]>;
  selectedIds: string[];
  scores: CompliancePayload["frameworkScores"];
  disclaimer?: string;
  emptyScan: boolean;
  onToggle: (id: string, checked: boolean) => void;
  variant: "empty" | "full";
}) {
  const label =
    variant === "full"
      ? "2 · Compliance framework alignment"
      : "Compliance frameworks (saved for this project)";
  return (
    <section className={styles.section} aria-labelledby="fw-heading">
      <div id="fw-heading" className={styles.sectionLabel}>
        {label}
      </div>
      {disclaimer ? <p className={styles.fwDisclaimer}>{disclaimer}</p> : null}
      {emptyScan ? (
        <p className={styles.fwScanHint}>
          Run a completed scan to populate per-control scores. Your framework selection is saved on this project.
        </p>
      ) : null}
      <div className={styles.fwPicker}>
        {catalog.map((fw) => (
          <label key={fw.id} className={styles.fwPickerLabel}>
            <input
              type="checkbox"
              checked={selectedIds.includes(fw.id)}
              onChange={(e) => {
                onToggle(fw.id, e.target.checked);
              }}
            />
            <span className={styles.fwPickerText}>
              <strong>{fw.shortLabel}</strong>
              <span className={styles.fwPickerName}>{fw.name}</span>
            </span>
          </label>
        ))}
      </div>
      {!emptyScan && (!scores || scores.length === 0) ? (
        <p className={styles.fwNoneHint}>
          No frameworks selected. Check one or more above to see alignment scores.
        </p>
      ) : null}
      {scores && scores.length > 0 && !emptyScan ? (
        <div className={styles.fwScoreGrid}>
          {scores.map((fw) => (
            <div key={fw.frameworkId} className={styles.fwCard}>
              <div className={styles.fwCardHead}>
                <h3 className={styles.fwCardTitle}>{fw.frameworkName}</h3>
                <div className={styles.fwOverall} aria-label={`Overall score ${fw.overallScore} out of 100`}>
                  <span className={styles.fwOverallLabel}>Overall</span>
                  <span className={styles.fwOverallVal}>{fw.overallScore}</span>
                  <span className={styles.fwOverallOf}>/100</span>
                </div>
              </div>
              <p className={styles.fwCardDesc}>{fw.description}</p>
              <ul className={styles.fwCritList}>
                {fw.criteria.map((c) => (
                  <li key={c.id} className={styles.fwCritItem}>
                    <div className={styles.fwCritRow}>
                      <div className={styles.fwCritText}>
                        <span className={styles.fwCritLabel}>{c.label}</span>
                        <span className={styles.fwCritNums}>
                          {c.matchedFindingCount} matched · {c.unresolvedCount} open
                        </span>
                      </div>
                      <StepScoreIndicator score={c.score} compact />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
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

  /** Latest framework selection (survives overlapping GET/PATCH races). null = never touched, trust server payload. */
  const frameworkSelectionRef = useRef<string[] | null>(null);
  const loadSeqRef = useRef(0);
  const patchSeqRef = useRef(0);

  useEffect(() => {
    frameworkSelectionRef.current = null;
  }, [projectId]);

  const loadReport = useCallback(async () => {
    if (!projectId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/compliance-report`, {
        credentials: "include",
        cache: "no-store",
      });
      const json = (await readApiResponse(r)) as CompliancePayload;
      if (!r.ok) throw new Error((json as { error?: string }).error || "Failed to load compliance report");
      if (seq !== loadSeqRef.current) return;
      setData(() => {
        const inc = json;
        const sel = frameworkSelectionRef.current;
        return {
          ...inc,
          selectedFrameworkIds: sel !== null ? [...sel] : (inc.selectedFrameworkIds ?? []),
        };
      });
      if (frameworkSelectionRef.current === null) {
        frameworkSelectionRef.current = json.selectedFrameworkIds ?? [];
      }
    } catch (e) {
      if (seq === loadSeqRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [projectId]);

  const displayScores = useMemo(() => {
    if (!data?.frameworkScores?.length) return [];
    const ids = data?.selectedFrameworkIds ?? [];
    return data.frameworkScores.filter((fw) => ids.includes(fw.frameworkId));
  }, [data?.frameworkScores, data?.selectedFrameworkIds]);

  async function toggleFramework(fwId: string, checked: boolean) {
    if (!projectId || !session || !data?.frameworkCatalog) return;
    const prev = [...(frameworkSelectionRef.current ?? data.selectedFrameworkIds ?? [])];
    let next = [...prev];
    if (checked) {
      if (!next.includes(fwId)) next.push(fwId);
    } else {
      next = next.filter((id) => id !== fwId);
    }
    const patchId = ++patchSeqRef.current;
    frameworkSelectionRef.current = next;
    setData((d) => (d ? { ...d, selectedFrameworkIds: next } : null));
    try {
      const r = await fetch(`/api/projects/${projectId}/compliance-frameworks`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frameworkIds: next }),
      });
      const json = (await readApiResponse(r)) as { error?: string; frameworkIds?: string[] };
      if (!r.ok) throw new Error(json.error || "Save failed");
      if (patchId !== patchSeqRef.current) return;
      const saved = json.frameworkIds ?? next;
      frameworkSelectionRef.current = saved;
      setData((d) => (d ? { ...d, selectedFrameworkIds: saved } : null));
    } catch (e) {
      if (patchId !== patchSeqRef.current) return;
      frameworkSelectionRef.current = prev;
      setData((d) => (d ? { ...d, selectedFrameworkIds: prev } : null));
      alert(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function downloadMarkdown() {
    if (!projectId || !session) return;
    setDownloadBusy(true);
    try {
      const ids = data?.selectedFrameworkIds ?? [];
      const fw =
        ids.length > 0 ? `?frameworks=${encodeURIComponent(ids.join(","))}` : "";
      const r = await fetch(`/api/projects/${projectId}/compliance-report/export${fw}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) {
        const json = (await readApiResponse(r)) as { error?: string };
        throw new Error(json.error || "Download failed");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition");
      let filename = `Signal-Compliance-${projectId}.pdf`;
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
    void loadReport();
  }, [projectId, pending, session, loadReport]);

  if (!pending && !session) {
    return (
      <main className={styles.root}>
        <div className={styles.shell}>
          <h1 className={styles.title}>Compliance Report</h1>
          <p className={styles.sub}>Please log in to view this report.</p>
          <Link href="/login" className={styles.back}>
            Go to login
          </Link>
        </div>
      </main>
    );
  }

  const es = data?.executiveSummary;
  const selectedIds = data?.selectedFrameworkIds ?? [];
  const verdictClass =
    data?.verdict?.tone === "strong"
      ? `${styles.verdict} ${styles.verdictStrong}`
      : data?.verdict?.tone === "warn"
        ? `${styles.verdict} ${styles.verdictWarn}`
        : styles.verdict;

  return (
    <main className={styles.root}>
      <div className={styles.topnav}>
        <Link href="/" className={styles.brand} aria-label="Signal home">
          <Image src="/signal_evenbigger.png" alt="" width={44} height={44} priority />
          <span className={styles.brandSignal}>Signal</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <span style={{ fontWeight: 650 }}>Compliance Report</span>
        </Link>
        <div className={styles.navActions}>
          <button
            type="button"
            className={styles.download}
            disabled={downloadBusy || pending || !session}
            onClick={() => void downloadMarkdown()}
          >
            {downloadBusy ? "Preparing…" : "Download PDF report"}
          </button>
          <Link href="/dashboard" className={styles.back}>
            Dashboard
          </Link>
        </div>
      </div>

      <div className={styles.shell}>
        <h1 className={styles.title}>Compliance Report</h1>
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

        {!loading && data?.frameworkCatalog && data.emptyReason === "no_completed_scan" ? (
          <FrameworkAlignmentSection
            variant="empty"
            catalog={data.frameworkCatalog}
            selectedIds={selectedIds}
            scores={data.frameworkScores}
            disclaimer={data.frameworkDisclaimer}
            emptyScan
            onToggle={toggleFramework}
          />
        ) : null}

        {!loading && data && !data.emptyReason && es ? (
          <>
            <section className={styles.section} aria-labelledby="exec-heading">
              <div id="exec-heading" className={styles.sectionLabel}>
                1 · Executive summary (~10–15s read)
              </div>
              <ExecutiveSummaryVisuals es={es} riskAreas={data.riskAreas} />
              <div className={styles.execCardMuted} style={{ marginTop: "0.75rem" }}>
                <strong>Status:</strong> {es.statusLine}
              </div>
            </section>

            {data.frameworkCatalog ? (
              <FrameworkAlignmentSection
                variant="full"
                catalog={data.frameworkCatalog}
                selectedIds={selectedIds}
                scores={displayScores}
                disclaimer={data.frameworkDisclaimer}
                emptyScan={false}
                onToggle={toggleFramework}
              />
            ) : null}

            <section className={styles.section} aria-labelledby="risk-heading">
              <div id="risk-heading" className={styles.sectionLabel}>
                3 · High-level risk areas
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
                  4 · What Signal fixed (trust &amp; remediation)
                </div>
                <p className={styles.fixIntro}>
                  Remediation coverage from finding status and completed PR workflows in Signal.
                </p>
                <div className={styles.fixPanel}>
                  <div className={styles.fixGrid}>
                    <div className={`${styles.fixStat} ${styles.fixStatCritical}`}>
                      <span className={styles.fixPill}>Critical</span>
                      <div className={styles.fixMetricValue}>{data.signalFixes.criticalResolvedPct}%</div>
                      <div className={styles.fixLabel}>
                        Resolved ({data.signalFixes.criticalResolved}/{data.signalFixes.criticalTotal})
                      </div>
                    </div>
                    <div className={`${styles.fixStat} ${styles.fixStatHigh}`}>
                      <span className={styles.fixPill}>High</span>
                      <div className={styles.fixMetricValue}>{data.signalFixes.highResolvedPct}%</div>
                      <div className={styles.fixLabel}>
                        Resolved ({data.signalFixes.highResolved}/{data.signalFixes.highTotal})
                      </div>
                    </div>
                    <div className={`${styles.fixStat} ${styles.fixStatDuration}`}>
                      <span className={styles.fixPill}>PR jobs</span>
                      <div className={styles.fixMetricValue}>
                        {data.signalFixes.avgFixHours != null ? `${data.signalFixes.avgFixHours}h` : "—"}
                      </div>
                      <div className={styles.fixLabel}>Avg. resolution job duration</div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="str-heading">
              <div id="str-heading" className={styles.sectionLabel}>
                5 · Security strengths
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
                  6 · Final verdict
                </div>
                <div className={verdictClass}>
                  <h3>{data.verdict.headline}</h3>
                  <p>{data.verdict.subtext}</p>
                </div>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="tl-heading">
              <div id="tl-heading" className={styles.sectionLabel}>
                7 · Timeline &amp; evidence
              </div>
              <p className={`${styles.sub} ${styles.timelineSub}`}>
                Scan milestones and completed remediation jobs (PRs). Use alongside your change-management records.
              </p>
              <div className={styles.timeline}>
                {(data.timeline ?? []).map((t, i) => (
                  <div key={`${t.at}-${i}`} className={styles.tlRow}>
                    <div className={styles.tlDate}>{fmtWhen(t.at)}</div>
                    <div className={styles.tlBody}>
                      <span className={styles.tlText}>{t.label}</span>
                      {t.evidence?.prUrl ? (
                        <a className={styles.tlPrBtn} href={t.evidence.prUrl} target="_blank" rel="noreferrer">
                          View PR
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="ev-heading">
              <div id="ev-heading" className={styles.sectionLabel}>
                8 · Finding detail — impact, exploit path, fix
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
                      <dd className={styles.evFixDd}>
                        <span>{ev.whatWasFixed}</span>
                        {ev.prUrl ? (
                          <a className={styles.tlPrBtn} href={ev.prUrl} target="_blank" rel="noreferrer">
                            View PR
                          </a>
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

