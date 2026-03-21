"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./MemoryTablePanel.module.css";

type EntityType = "findings" | "dismissals" | "regressions" | "acceptedRisks" | "fixOutcomes" | "baseline" | "developerProfiles";

const ENTITY_LABELS: Record<EntityType, string> = {
  findings: "Findings",
  dismissals: "Dismissals",
  regressions: "Regressions",
  acceptedRisks: "Accepted Risks",
  fixOutcomes: "Fix Outcomes",
  baseline: "Baseline",
  developerProfiles: "Dev Profiles",
};

type SortDir = "asc" | "desc";
type SortState = { col: string; dir: SortDir };

/* eslint-disable @typescript-eslint/no-explicit-any */
type MemoryTableData = {
  findings: any[];
  dismissals: any[];
  regressions: any[];
  acceptedRisks: any[];
  fixOutcomes: { stats: Record<string, any>; data: any[] };
  baseline: Record<string, any> | null;
  developerProfiles: any[];
};

function severityClass(sev: string) {
  switch (sev) {
    case "critical": return styles.severityCritical;
    case "high": return styles.severityHigh;
    case "medium": return styles.severityMedium;
    case "low": return styles.severityLow;
    default: return "";
  }
}

function statusClass(st: string) {
  switch (st) {
    case "merged": return styles.statusMerged;
    case "open": return styles.statusOpen;
    case "closed": return styles.statusClosed;
    default: return "";
  }
}

function sortRows(rows: any[], sort: SortState): any[] {
  if (!sort.col) return rows;
  return [...rows].sort((a, b) => {
    const av = a[sort.col];
    const bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return sort.dir === "asc" ? av - bv : bv - av;
    }
    const sa = String(av).toLowerCase();
    const sb = String(bv).toLowerCase();
    const cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

function formatDate(val: string | null | undefined): string {
  if (!val) return "—";
  const d = new Date(val);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

type Props = {
  projectId?: string;
};

export default function MemoryTablePanel({ projectId }: Props) {
  const [data, setData] = useState<MemoryTableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<EntityType>("findings");
  const [sort, setSort] = useState<SortState>({ col: "", dir: "desc" });

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/projects/${projectId}/memory-table`, { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load memory data");
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [projectId]);

  const toggleSort = useCallback((col: string) => {
    setSort((prev) => {
      if (prev.col === col) return { col, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { col, dir: "desc" };
    });
  }, []);

  const counts: Record<EntityType, number> = useMemo(() => ({
    findings: data?.findings?.length ?? 0,
    dismissals: data?.dismissals?.length ?? 0,
    regressions: data?.regressions?.length ?? 0,
    acceptedRisks: data?.acceptedRisks?.length ?? 0,
    fixOutcomes: data?.fixOutcomes?.data?.length ?? 0,
    baseline: data?.baseline ? 1 : 0,
    developerProfiles: data?.developerProfiles?.length ?? 0,
  }), [data]);

  const renderSortHeader = useCallback(
    (col: string, label: string) => (
      <th onClick={() => toggleSort(col)}>
        {label}
        {sort.col === col && <span className={styles.sortArrow}>{sort.dir === "asc" ? "\u25B2" : "\u25BC"}</span>}
      </th>
    ),
    [sort, toggleSort],
  );

  if (!projectId) {
    return <div className={styles.root}><div className={styles.empty}>Select a project to view memory data</div></div>;
  }

  if (loading) {
    return <div className={styles.root}><div className={styles.loading}>Loading memory data...</div></div>;
  }

  if (error) {
    return <div className={styles.root}><div className={styles.empty}>{error}</div></div>;
  }

  if (!data) {
    return <div className={styles.root}><div className={styles.empty}>No data available</div></div>;
  }

  return (
    <div className={styles.root}>
      <div className={styles.filterRow}>
        {(Object.keys(ENTITY_LABELS) as EntityType[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.pill} ${activeEntity === key ? styles.pillActive : ""}`}
            onClick={() => { setActiveEntity(key); setSort({ col: "", dir: "desc" }); }}
          >
            {ENTITY_LABELS[key]}
            <span className={styles.badge}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {activeEntity === "baseline" ? (
        data.baseline ? (
          <div className={styles.tableWrap}>
            <div className={styles.baselineCard}>
              <div className={styles.baselineStat}>
                <span className={styles.baselineLabel}>Baseline Score</span>
                <span className={styles.baselineValue}>{Number(data.baseline.baselineScore).toFixed(2)}</span>
              </div>
              <div className={styles.baselineStat}>
                <span className={styles.baselineLabel}>Finding Count</span>
                <span className={styles.baselineValue}>{data.baseline.baselineFindingCount}</span>
              </div>
              <div className={styles.baselineStat}>
                <span className={styles.baselineLabel}>Std Dev</span>
                <span className={styles.baselineValue}>{Number(data.baseline.scoreStddev).toFixed(3)}</span>
              </div>
              <div className={styles.baselineStat}>
                <span className={styles.baselineLabel}>Window Size</span>
                <span className={styles.baselineValue}>{data.baseline.windowSize} scans</span>
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.empty}>No baseline computed yet. Run a few scans first.</div>
        )
      ) : activeEntity === "findings" ? (
        counts.findings === 0 ? (
          <div className={styles.empty}>No findings in the latest scan</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("severity", "Severity")}
                  {renderSortHeader("category", "Category")}
                  {renderSortHeader("filePath", "File Path")}
                  {renderSortHeader("status", "Status")}
                  {renderSortHeader("weightedScore", "Score")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.findings, sort).map((f: any) => (
                  <tr key={f.id}>
                    <td><span className={`${styles.severityPill} ${severityClass(f.severity)}`}>{f.severity}</span></td>
                    <td>{f.category}</td>
                    <td className={styles.mono}>{f.filePath}</td>
                    <td>{f.status}</td>
                    <td>{f.weightedScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : activeEntity === "dismissals" ? (
        counts.dismissals === 0 ? (
          <div className={styles.empty}>No dismissals recorded</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("fingerprint", "Fingerprint")}
                  {renderSortHeader("reason", "Reason")}
                  {renderSortHeader("scope", "Scope")}
                  {renderSortHeader("isActive", "Active")}
                  {renderSortHeader("createdAt", "Date")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.dismissals, sort).map((d: any) => (
                  <tr key={d.id}>
                    <td className={styles.mono}>{d.fingerprint?.slice(0, 16)}</td>
                    <td>{d.reason || "—"}</td>
                    <td>{d.scope || "—"}</td>
                    <td><span className={d.isActive ? styles.active : styles.inactive}>{d.isActive ? "Yes" : "No"}</span></td>
                    <td>{formatDate(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : activeEntity === "regressions" ? (
        counts.regressions === 0 ? (
          <div className={styles.empty}>No regressions detected</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("fingerprint", "Fingerprint")}
                  {renderSortHeader("resolvedInScanId", "Resolved Scan")}
                  {renderSortHeader("reappearedInScanId", "Reappeared Scan")}
                  {renderSortHeader("createdAt", "Date")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.regressions, sort).map((r: any) => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.fingerprint?.slice(0, 16)}</td>
                    <td className={styles.mono}>{String(r.resolvedInScanId).slice(0, 8)}</td>
                    <td className={styles.mono}>{String(r.reappearedInScanId).slice(0, 8)}</td>
                    <td>{formatDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : activeEntity === "acceptedRisks" ? (
        counts.acceptedRisks === 0 ? (
          <div className={styles.empty}>No accepted risks</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("fingerprint", "Fingerprint")}
                  {renderSortHeader("reason", "Reason")}
                  {renderSortHeader("isValid", "Valid")}
                  {renderSortHeader("reviewByDate", "Review By")}
                  {renderSortHeader("invalidatedReason", "Invalidated Reason")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.acceptedRisks, sort).map((ar: any) => (
                  <tr key={ar.id}>
                    <td className={styles.mono}>{ar.fingerprint?.slice(0, 16)}</td>
                    <td>{ar.reason || "—"}</td>
                    <td><span className={ar.isValid ? styles.active : styles.inactive}>{ar.isValid ? "Yes" : "No"}</span></td>
                    <td>{formatDate(ar.reviewByDate)}</td>
                    <td>{ar.invalidatedReason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : activeEntity === "fixOutcomes" ? (
        counts.fixOutcomes === 0 ? (
          <div className={styles.empty}>No fix outcomes recorded</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("prUrl", "PR")}
                  {renderSortHeader("prStatus", "Status")}
                  {renderSortHeader("fixCategory", "Category")}
                  {renderSortHeader("filesChanged", "Files Changed")}
                  {renderSortHeader("mergedAt", "Merged")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.fixOutcomes.data, sort).map((fo: any) => (
                  <tr key={fo.id}>
                    <td>
                      {fo.prUrl ? (
                        <a href={fo.prUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                          {fo.prUrl.replace(/^https?:\/\/github\.com\//, "")}
                        </a>
                      ) : "—"}
                    </td>
                    <td><span className={`${styles.statusPill} ${statusClass(fo.prStatus)}`}>{fo.prStatus}</span></td>
                    <td>{fo.fixCategory || "—"}</td>
                    <td>{fo.filesChanged ?? "—"}</td>
                    <td>{formatDate(fo.mergedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : activeEntity === "developerProfiles" ? (
        counts.developerProfiles === 0 ? (
          <div className={styles.empty}>No developer profiles yet</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {renderSortHeader("authorEmail", "Author")}
                  {renderSortHeader("totalFindings", "Total Findings")}
                  {renderSortHeader("criticalCount", "Crit")}
                  {renderSortHeader("highCount", "High")}
                  {renderSortHeader("mediumCount", "Med")}
                  {renderSortHeader("lowCount", "Low")}
                  {renderSortHeader("riskScore", "Risk Score")}
                </tr>
              </thead>
              <tbody>
                {sortRows(data.developerProfiles, sort).map((dp: any) => (
                  <tr key={dp.id || dp.authorEmail}>
                    <td>{dp.authorName || dp.authorEmail}</td>
                    <td>{dp.totalFindings}</td>
                    <td>{dp.criticalCount}</td>
                    <td>{dp.highCount}</td>
                    <td>{dp.mediumCount}</td>
                    <td>{dp.lowCount}</td>
                    <td>{dp.riskScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
