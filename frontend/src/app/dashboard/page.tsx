"use client";

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import styles from "./page.module.css";
import MemoryMapPanel from "@/components/memory/MemoryMapPanel";
import MemoryTablePanel from "@/components/memory/MemoryTablePanel";
import VectorExplorerPanel from "@/components/memory/VectorExplorerPanel";

type TeamMember = { email: string };
type TeamRow = { email: string; createdAt: string; updatedAt: string };

type AuditFindingChange = {
  fingerprint: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  lineNumber: number | null;
  weightedScore: number;
  filePath: string;
};

type AuditDiff = {
  addedCount: number;
  removedCount: number;
  changedCount: number;
  topAdded: AuditFindingChange[];
  topRemoved: AuditFindingChange[];
  topChanged: AuditFindingChange[];
};

type AuditEntry = {
  scanId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  ranByUserId: string | null;
  /** Display name from Better Auth user row (name, or email local-part) */
  ranByDisplayName?: string | null;
  securityScore: number | null;
  scoreDelta: number | null;
  prUrl?: string | null;
  prJobId?: string | null;
  prBranchName?: string | null;
  diff: AuditDiff | null;
};

type Project = {
  id: string;
  githubUrl: string;
  projectName: string;
  description: string;
  securityScore?: number | null;
  latestScanId?: string | null;
  latestScanStatus?: string | null;
  latestFindingsCount?: number | null;
  createdAt?: string;
};

const ALLOW_KEY = "signal_dashboard_allow_v1";
const TEAM_KEY = "signal_dashboard_team_v1";

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || "Unexpected server response" };
  }
}

async function waitForScanCompletion(projectId: string, scanId: string) {
  const maxAttempts = 90; // ~3 minutes
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const r = await fetch(
      `/api/projects/${projectId}/scans/${encodeURIComponent(scanId)}/status`,
      {
        credentials: "include",
        cache: "no-store",
      },
    );
    const json = await readApiResponse(r);
    if (!r.ok) throw new Error(json?.error || "Failed to fetch scan status");
    if (json?.status === "completed") return;
    if (json?.status === "failed") {
      throw new Error(json?.errorMessage || "Scan failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Scan timed out while waiting for completion");
}

function parseTeamMembers(raw: string): TeamMember[] {
  const parts = raw
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  // Basic email-like heuristic; backend can enforce stronger validation later.
  return parts
    .filter((email) => email.includes("@") && email.includes("."))
    .map((email) => ({ email }));
}

function isGitHubUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().includes("github.com");
  } catch {
    return false;
  }
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/+/, "");
  } catch {
    return url;
  }
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function usernameFromEmail(email: string) {
  return normalizeEmail(email).split("@")[0] || "member";
}

function timeAgo(ts: string) {
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return "just now";
  const diff = Date.now() - then;
  const mins = Math.max(1, Math.floor(diff / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(ts: string | null | undefined) {
  if (!ts) return "";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clampScore50(score: number | string | null | undefined): number | null {
  if (score == null) return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(50, n));
}

function scoreGaugeTone(score: number | null | undefined): "strong" | "warn" | "critical" | "unknown" {
  if (score == null) return "unknown";
  const s = clampScore50(score);
  if (s == null) return "unknown";
  if (s <= 10) return "strong";
  if (s <= 25) return "warn";
  return "critical";
}

function ProjectCreateModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (p: {
    githubUrl: string;
    projectName: string;
    description: string;
    teamMembers: TeamMember[];
    scanOnCreate: boolean;
  }) => Promise<void>;
}) {
  const [githubUrl, setGithubUrl] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamMembersRaw, setTeamMembersRaw] = useState("");
  const [scanInstantly, setScanInstantly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setError(null), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (open) setScanInstantly(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dash-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add codebase"
      onMouseDown={(e) => {
        if (!creating && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dash-modal">
        <div className="dash-modal__header">
          <div>
            <div className="dash-modal__title">Add codebase</div>
            <div className="dash-modal__subtitle">
              Connect Signal to a GitHub repo to start scanning.
            </div>
          </div>
          <button className="dash-modal__close" onClick={onClose} type="button" disabled={creating}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Close</span>
          </button>
        </div>

        <form
          className="dash-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);

            const githubUrlTrimmed = githubUrl.trim();
            const nameTrimmed = name.trim();
            if (!githubUrlTrimmed || !isGitHubUrl(githubUrlTrimmed)) {
              setError("Please enter a valid GitHub URL.");
              return;
            }
            if (!nameTrimmed) {
              setError("Project name is required.");
              return;
            }

            setCreating(true);
            try {
              await onCreate({
                githubUrl: githubUrlTrimmed,
                projectName: nameTrimmed,
                description: description.trim(),
                teamMembers: parseTeamMembers(teamMembersRaw),
                scanOnCreate: scanInstantly,
              });
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not create project");
            } finally {
              setCreating(false);
            }
          }}
        >
          <fieldset disabled={creating} style={{ border: "none", padding: 0, margin: 0 }}>
            <div className="dash-form__grid">
              <label className="dash-label">
                <span className="dash-label__text">GitHub URL</span>
                <input
                  className="dash-input"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  type="url"
                  required
                />
              </label>

              <label className="dash-label">
                <span className="dash-label__text">Project name</span>
                <input
                  className="dash-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Service"
                  required
                />
              </label>
            </div>

            <label className="dash-label">
              <span className="dash-label__text">Description (optional)</span>
              <textarea
                className="dash-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this codebase do?"
                rows={3}
              />
            </label>

            <label className="dash-label">
              <span className="dash-label__text">Team members (optional)</span>
              <input
                className="dash-input"
                value={teamMembersRaw}
                onChange={(e) => setTeamMembersRaw(e.target.value)}
                placeholder="alice@company.com, bob@company.com"
              />
            </label>

            <label
              className="dash-label"
              style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={scanInstantly}
                onChange={(e) => setScanInstantly(e.target.checked)}
                style={{ marginTop: "0.2rem", width: "1rem", height: "1rem", flexShrink: 0, accentColor: "var(--dash-accent, #ff5a34)" }}
              />
              <span>
                <span className="dash-label__text" style={{ display: "block", marginBottom: "0.15rem" }}>
                  Scan instantly when added
                </span>
                <span style={{ fontSize: "0.85em", color: "var(--dash-muted, rgba(255,220,210,0.72))", lineHeight: 1.45 }}>
                  Runs the first scan in the background right after the project is created (recommended). Turn off to add the repo only and run a scan manually later.
                </span>
              </span>
            </label>
          </fieldset>

          {creating && (
            <div className="dash-create__progress">
              <div className="dash-create__progress-bar" />
              <span>{scanInstantly ? "Adding project and starting scan…" : "Setting up your project…"}</span>
            </div>
          )}

          {error ? (
            <div className="dash-inline-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="dash-form__actions">
            <button
              className="dash-btn dash-btn--secondary"
              type="button"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </button>
            <button className="dash-btn dash-btn--primary" type="submit" disabled={creating}>
              {creating ? (
                <>
                  <span className="dash-delete__spinner dash-delete__spinner--inline" aria-hidden="true" />
                  Adding…
                </>
              ) : (
                "Add project"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({
  open,
  projectName,
  deleting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  projectName: string;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirmInput, setConfirmInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const expected = projectName.trim();
  const canDelete = expected.length > 0 && confirmInput.trim() === expected;

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setConfirmInput("");
      return;
    }
    setConfirmInput("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, projectName]);

  useEffect(() => {
    if (!open || deleting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, deleting, onClose]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="dash-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dash-delete-title"
      aria-describedby="dash-delete-desc"
      onMouseDown={(e) => {
        if (!deleting && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dash-modal dash-modal--delete">
        <div className="dash-delete__icon-wrap" aria-hidden="true">
          <div className="dash-delete__icon-bg">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
        </div>

        <div className="dash-delete__body">
          <div id="dash-delete-title" className="dash-delete__title">
            Delete project
          </div>
          <div id="dash-delete-desc" className="dash-delete__desc">
            Are you sure you want to delete <strong>{projectName}</strong>? This will permanently remove the project along with all its scans and findings. This action cannot be undone.
          </div>
          <div className="dash-delete__confirm">
            <label htmlFor="dash-delete-confirm-input">Type the project name to confirm</label>
            <input
              id="dash-delete-confirm-input"
              ref={inputRef}
              type="text"
              className="dash-delete__confirmInput"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              disabled={deleting}
              autoComplete="off"
              spellCheck={false}
              placeholder={expected || "Project name"}
            />
          </div>
        </div>

        {deleting && (
          <div className="dash-delete__progress">
            <div className="dash-delete__spinner" aria-hidden="true" />
            <span>Deleting project and all associated data…</span>
          </div>
        )}

        <div className="dash-delete__actions">
          <button
            className="dash-btn dash-btn--secondary"
            type="button"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            className="dash-btn dash-btn--danger"
            type="button"
            onClick={onConfirm}
            disabled={deleting || !canDelete}
            title={!canDelete ? "Enter the exact project name above to enable" : undefined}
          >
            {deleting ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CodebaseDropzone({
  disabled,
  onOpenCreate,
  onOpenArchiveLink,
  variant = "default",
}: {
  disabled: boolean;
  onOpenCreate: () => void;
  onOpenArchiveLink: () => void;
  variant?: "default" | "banner";
}) {
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div className="dash-dropzone-wrap">
      <div
        className={[
          "dash-dropzone",
          variant === "banner" ? "dash-dropzone--banner" : "",
          isDragging ? "dash-dropzone--dragging" : "",
          disabled ? "dash-dropzone--disabled" : "",
        ].join(" ")}
        onDragEnter={(e) => {
          if (disabled) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setIsDragging(false);
          // UX-only: we don't parse local files here yet.
          onOpenCreate();
        }}
      >
        <div className="dash-dropzone__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3.08" />
            <path d="M16 6l-4-4-4 4" />
            <path d="M12 2v14" />
          </svg>
        </div>
        <div className="dash-dropzone__title">Drop a repo archive</div>
        <div className="dash-dropzone__subtitle">
          {variant === "banner"
            ? "Drop an archive here, or add via GitHub URL below."
            : "Or connect using a GitHub URL."}
        </div>

        {variant === "banner" ? (
          <>
            <button
              type="button"
              className="dash-btn dash-btn--primary dash-btn--wide"
              onClick={onOpenCreate}
              disabled={disabled}
            >
              Drop repo archive
            </button>
            <button
              type="button"
              className="dash-dropzone__link dash-dropzone__link--github"
              onClick={onOpenArchiveLink}
              disabled={disabled}
            >
              Add via GitHub URL →
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="dash-dropzone__link"
              onClick={onOpenArchiveLink}
              disabled={disabled}
            >
              Drop a repo archive link →
            </button>
            <button
              type="button"
              className="dash-btn dash-btn--primary dash-btn--wide"
              onClick={onOpenCreate}
              disabled={disabled}
            >
              Add codebase
            </button>
          </>
        )}
        {disabled ? (
          <div className="dash-dropzone__disabled-hint">
            Log in to add codebases.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Custom project dropdown for Audit section ── */
function AuditProjectDropdown({
  projects,
  value,
  onChange,
}: {
  projects: { id: string; projectName: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = projects.find((p) => p.id === value);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="dash-auditSelectWrap" ref={ref}>
      <span className="dash-auditSelectLabel">Project</span>
      <button
        type="button"
        className="dash-auditDropdownBtn"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dash-auditDropdownBtnText">{selected?.projectName ?? "Select project"}</span>
        <svg
          className={`dash-auditDropdownChevron${open ? " dash-auditDropdownChevronOpen" : ""}`}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="dash-auditDropdownMenu">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`dash-auditDropdownItem${p.id === value ? " dash-auditDropdownItemActive" : ""}`}
                onClick={() => { onChange(p.id); setOpen(false); }}
              >
                {p.projectName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Top bar: Memory / project name. Uses a native select when there are 2+ projects so the dropdown is obvious. */
function MemoryProjectBreadcrumb({
  projects,
  value,
  onChange,
  onGoHome,
}: {
  projects: { id: string; projectName: string }[];
  value: string;
  onChange: (id: string) => void;
  /** Single-project row: return to main dashboard view */
  onGoHome: () => void;
}) {
  const selected = projects.find((p) => p.id === value) ?? projects[0];
  const multi = projects.length > 1;
  const label =
    selected?.projectName ?? (projects.length === 0 ? "No project" : projects[0]?.projectName ?? "Project");
  const selectValue = selected?.id ?? "";

  if (multi) {
    return (
      <label className="dash-memCrumbLabelRow" htmlFor="dash-memory-project-select">
        <span className="dash-pageTitle__signal">Memory</span>
        <span className="dash-pageTitle__sep">/</span>
        <div className="dash-memCrumbWrap">
          <select
            id="dash-memory-project-select"
            className="dash-memCrumbSelect"
            value={selectValue}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Choose project for memory map"
          >
            {projects.map((p) => (
              <option
                key={p.id}
                value={p.id}
                style={{ backgroundColor: "#1a0c08", color: "#fff0ea" }}
              >
                {p.projectName}
              </option>
            ))}
          </select>
        </div>
      </label>
    );
  }

  return (
    <button
      type="button"
      className="dash-memCrumbSingleBtn"
      title={label}
      aria-label={`Memory map — ${label}. Go to dashboard home.`}
      onClick={onGoHome}
    >
      <span className="dash-pageTitle__signal">Memory</span>
      <span className="dash-pageTitle__sep">/</span>
      <span className="dash-pageTitle__item dash-memCrumbSingle">{label}</span>
    </button>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<any | null>(null);
  const [isPending, setIsPending] = useState<boolean>(true);
  const isAuthed = !!session;
  const [projects, setProjects] = useState<Project[]>([]);
  const [scanBusy, setScanBusy] = useState<Record<string, boolean>>({});
  const [deleteBusy, setDeleteBusy] = useState<Record<string, boolean>>({});
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [allowSignal, setAllowSignal] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [showLogout, setShowLogout] = useState(false);
  const [booting, setBooting] = useState<boolean>(false);
  const [bootChecked, setBootChecked] = useState<boolean>(false);
  const [bootAnimDone, setBootAnimDone] = useState(false);
  const [initialProjectsLoaded, setInitialProjectsLoaded] = useState(false);
  const initialProjectsLoadedRef = useRef(false);
  const [activeSection, setActiveSection] = useState<"home" | "teams" | "audit" | "memory" | "webhooks">("home");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [webhookNotice, setWebhookNotice] = useState<string | null>(null);
  const [teamView, setTeamView] = useState<"members" | "settings">("members");
  const [teamMembers, setTeamMembers] = useState<TeamRow[]>([]);
  const [teamInvite, setTeamInvite] = useState("");
  const [teamError, setTeamError] = useState<string | null>(null);

  const [auditProjectId, setAuditProjectId] = useState<string | null>(null);
  const [memoryProjectId, setMemoryProjectId] = useState<string | null>(null);
  const [memoryView, setMemoryView] = useState<"graph" | "table" | "vectors">("graph");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const BOOT_ANIM_MS = 3200; // 2s logo pulse + loading bar

  useEffect(() => {
    // Fetch session once to avoid continuous polling pressure on MySQL.
    let cancelled = false;
    async function run() {
      setIsPending(true);
      try {
        const r = await (authClient as any).getSession?.();
        // better-auth commonly returns { data, error }.
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
    startTransition(() => {
      setAllowSignal(localStorage.getItem(ALLOW_KEY) === "1");
    });
  }, []);

  useEffect(() => {
    // Prevent hydration mismatch: determine boot overlay only after mount.
    try {
      setBooting(sessionStorage.getItem("signal_dashboard_boot") === "1");
    } catch {
      setBooting(false);
    }
    setBootChecked(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.location.hash.replace(/^#/, "");
    if (raw === "teams" || raw === "audit" || raw === "memory" || raw === "webhooks") {
      setActiveSection(raw);
    }
  }, []);

  useEffect(() => {
    if (!booting) return;
    try {
      sessionStorage.removeItem("signal_dashboard_boot");
    } catch {
      // no-op
    }
    const t = window.setTimeout(() => setBootAnimDone(true), BOOT_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [booting]);

  useEffect(() => {
    if (!booting) return;
    if (!bootAnimDone) return;
    setBooting(false);
  }, [booting, bootAnimDone]);

  useEffect(() => {
    if (isAuthed) return;
    if (isPending) return; // wait for session resolution
    if (initialProjectsLoadedRef.current) return;
    initialProjectsLoadedRef.current = true;
    setInitialProjectsLoaded(true);
  }, [isAuthed, isPending]);

  useEffect(() => {
    if (!isAuthed) {
      setTeamMembers([]);
      return;
    }
    const ownerEmail = normalizeEmail(String((session as any)?.user?.email ?? ""));
    let stored: string[] = [];
    try {
      const raw = localStorage.getItem(TEAM_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        stored = parsed
          .map((v) => {
            if (typeof v === "string") return normalizeEmail(v);
            if (v && typeof v === "object" && "email" in (v as any)) return normalizeEmail(String((v as any).email));
            return "";
          })
          .filter(Boolean);
      }
    } catch {
      stored = [];
    }
    const nowIso = new Date().toISOString();
    const merged = Array.from(new Set([ownerEmail, ...stored].filter(Boolean))).map((email) => ({
      email,
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
    setTeamMembers(merged);
  }, [isAuthed, session]);

  useEffect(() => {
    if (!isAuthed) return;
    localStorage.setItem(TEAM_KEY, JSON.stringify(teamMembers));
  }, [isAuthed, teamMembers]);

  useEffect(() => {
    // Keep audit project selection valid as projects change.
    if (!isAuthed) return;
    if (activeSection !== "audit") return;
    if (auditProjectId && projects.some((p) => p.id === auditProjectId)) return;
    setAuditProjectId(projects[0]?.id ?? null);
  }, [activeSection, auditProjectId, isAuthed, projects]);

  useEffect(() => {
    if (!isAuthed) return;
    if (activeSection !== "memory") return;
    if (memoryProjectId && projects.some((p) => p.id === memoryProjectId)) return;
    setMemoryProjectId(projects[0]?.id ?? null);
  }, [activeSection, memoryProjectId, isAuthed, projects]);

  useEffect(() => {
    if (!isAuthed) return;
    if (activeSection !== "webhooks") return;

    let cancelled = false;
    async function loadWebhook() {
      setWebhookBusy(true);
      setWebhookError(null);
      setWebhookNotice(null);
      try {
        const r = await fetch("/api/projects/webhook", {
          credentials: "include",
          cache: "no-store",
        });
        const json = await readApiResponse(r);
        if (!r.ok) throw new Error(json?.error || "Could not load webhook settings");
        if (cancelled) return;
        setWebhookUrl(typeof json?.webhookUrl === "string" ? json.webhookUrl : "");
        setWebhookEnabled(!!json?.enabled);
      } catch (e) {
        if (!cancelled) setWebhookError(e instanceof Error ? e.message : "Could not load webhook settings");
      } finally {
        if (!cancelled) setWebhookBusy(false);
      }
    }
    void loadWebhook();

    return () => {
      cancelled = true;
    };
  }, [activeSection, isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    if (activeSection !== "audit") return;
    if (!auditProjectId) return;

    let cancelled = false;
    async function loadAudit() {
      setAuditLoading(true);
      setAuditError(null);
      try {
        const r = await fetch(`/api/projects/${auditProjectId}/audit?limit=8`, {
          credentials: "include",
          cache: "no-store",
        });
        const json = await readApiResponse(r);
        if (!r.ok) throw new Error(json?.error || "Failed to load audit");
        if (!cancelled) setAuditEntries(Array.isArray(json?.data) ? (json.data as AuditEntry[]) : []);
      } catch (e) {
        if (!cancelled) setAuditError(e instanceof Error ? e.message : "Failed to load audit");
      } finally {
        if (!cancelled) setAuditLoading(false);
      }
    }

    void loadAudit();
    return () => {
      cancelled = true;
    };
  }, [activeSection, auditProjectId, isAuthed]);

  const loadProjects = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!isAuthed) {
      setProjects([]);
      if (!initialProjectsLoadedRef.current) {
        initialProjectsLoadedRef.current = true;
        setInitialProjectsLoaded(true);
      }
      return;
    }
    if (!silent) setLoadingProjects(true);
    try {
      const r = await fetch("/api/projects", { credentials: "include", cache: "no-store" });
      const json = await readApiResponse(r);
      if (!r.ok) throw new Error(json?.error || "Failed to load projects");
      setProjects(Array.isArray(json?.data) ? json.data : []);
    } catch (e) {
      console.error("Failed to load projects", e);
      if (!silent) setProjects([]);
    } finally {
      if (!silent) setLoadingProjects(false);
      if (!initialProjectsLoadedRef.current) {
        initialProjectsLoadedRef.current = true;
        setInitialProjectsLoaded(true);
      }
    }
  }, [isAuthed]);

  useEffect(() => {
    if (!isAuthed) {
      setProjects([]);
      return;
    }
    void loadProjects();
  }, [isAuthed, loadProjects]);

  const hasActiveDashboardScans = useMemo(() => {
    if (Object.values(scanBusy).some(Boolean)) return true;
    return projects.some((p) => p.latestScanStatus === "running");
  }, [projects, scanBusy]);

  useEffect(() => {
    if (!isAuthed || !hasActiveDashboardScans) return;
    void loadProjects({ silent: true });
    const id = window.setInterval(() => {
      void loadProjects({ silent: true });
    }, 2500);
    return () => window.clearInterval(id);
  }, [isAuthed, hasActiveDashboardScans, loadProjects]);

  const projectsCount = projects.length;
  const ownerEmail = normalizeEmail(String((session as any)?.user?.email ?? ""));
  const currentUserId = String((session as any)?.user?.id ?? "");
  const auditProject = auditProjectId ? projects.find((p) => p.id === auditProjectId) ?? null : null;
  const memoryProject = memoryProjectId ? projects.find((p) => p.id === memoryProjectId) ?? null : null;
  const teamCount = teamMembers.length;

  const displayName =
    (session as any)?.user?.name ??
    (session as any)?.user?.username ??
    (session as any)?.user?.email ??
    "Account";

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!userMenuRef.current) return;
      if (!userMenuRef.current.contains(e.target as Node)) {
        setShowLogout(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await authClient.signOut();
    } catch {
      // no-op
    } finally {
      router.push("/login");
      router.refresh();
    }
  }, [router]);

  const headerRight = useMemo(() => {
    if (isPending) return null;
    if (!isAuthed)
      return (
        <Link className="action action-primary" href="/login">
          Log in
        </Link>
      );
    return (
      <div className="dash-userMenu" ref={userMenuRef}>
        <button
          type="button"
          className="dash-user"
          aria-label="Signed in user"
          aria-expanded={showLogout}
          onClick={() => setShowLogout((v) => !v)}
        >
          <span className="dash-user__icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span className="dash-user__name">{String(displayName)}</span>
        </button>
        {showLogout ? (
          <div className="dash-user__dropdown" role="menu">
            <div className="dash-user__dropdown-header">
              <span className="dash-user__dropdown-avatar" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
              <div className="dash-user__dropdown-info">
                <span className="dash-user__dropdown-name">{String(displayName)}</span>
                {(session as any)?.user?.email ? (
                  <span className="dash-user__dropdown-email">{String((session as any).user.email)}</span>
                ) : null}
              </div>
            </div>
            <button type="button" className="dash-user__logout" role="menuitem" onClick={handleLogout}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Log out
            </button>
          </div>
        ) : null}
      </div>
    );
  }, [displayName, handleLogout, isAuthed, isPending, session, showLogout]);

  const topNavCrumb = activeSection === "memory" ? "Memory" : "Dashboard";

  /** Leave Memory tab for main dashboard content — local state + URL hash only (no Next router). */
  const exitMemoryToHome = useCallback(() => {
    setActiveSection("home");
    try {
      window.history.replaceState(null, "", "/dashboard");
    } catch {
      // no-op
    }
  }, []);

  if (booting && bootChecked) {
    return (
      <main
        className="dash-boot"
        aria-label="Loading dashboard"
        style={{ ["--boot-ms" as any]: `${BOOT_ANIM_MS}ms` }}
      >
        <div className="dash-boot__bg" aria-hidden="true" />
        <div className="dash-boot__inner">
          <div className="dash-boot__logoWrap" aria-hidden="true">
            <Image src="/signal_evenbigger.png" alt="" width={78} height={78} className="dash-boot__logo" priority />
          </div>
          <div className="dash-boot__title" aria-hidden="true">
            <span className="dash-boot__signal">Signal</span>
            <span className="dash-boot__sep">/</span>
            <span className="dash-boot__item">Dashboard</span>
          </div>

          <div className="dash-boot__bar" aria-hidden="true">
            <div className="dash-boot__barFill" />
          </div>
        </div>
      </main>
    );
  }

  if (!bootChecked) {
    return null;
  }

  return (
    <div className={`dashboard ${styles.root}`}>
      <div className="dash-topnav">
        <div className="brand">
          <Link
            href={activeSection === "memory" ? "/dashboard" : "/"}
            className="dash-brand-logoLink"
            aria-label={activeSection === "memory" ? "Back to dashboard home" : "Signal home"}
            onClick={(e) => {
              if (activeSection !== "memory") return;
              e.preventDefault();
              exitMemoryToHome();
            }}
          >
            <Image
              src="/signal_evenbigger.png"
              alt=""
              width={60}
              height={60}
              className="dash-brand-logo"
              priority
              aria-hidden
            />
          </Link>
          <div className="dash-pageTitle" aria-hidden="true">
            {activeSection === "memory" ? (
              <MemoryProjectBreadcrumb
                projects={projects}
                value={memoryProject?.id ?? ""}
                onChange={setMemoryProjectId}
                onGoHome={exitMemoryToHome}
              />
            ) : (
              <>
                <span className="dash-pageTitle__signal">Signal</span>
                <span className="dash-pageTitle__sep">/</span>
                <span className="dash-pageTitle__item">{topNavCrumb}</span>
              </>
            )}
          </div>
        </div>
        <div className="dash-topnav__right">{headerRight}</div>
      </div>

      <div className="dash-shell">
        {activeSection === "home" ? (
          <>
            <div className="dash-banner">
              <div className="dash-banner__content">
                <div className="dash-banner__text">
                  <div className="dash-banner__title">Allow Signal to view your code base</div>
                  <div className="dash-banner__subtitle">
                    To get started, drop a codebase in the file dropper to the right. You can also add a repo archive link instead.
                  </div>
                  <div className="dash-banner__actions">
                    {allowSignal ? (
                      <span className="dash-pill dash-pill--ok">Allowed</span>
                    ) : (
                      <button
                        className="dash-btn dash-btn--primary"
                        type="button"
                        onClick={() => {
                          localStorage.setItem(ALLOW_KEY, "1");
                          setAllowSignal(true);
                        }}
                      >
                        Allow Signal
                      </button>
                    )}
                  </div>
                </div>

                <div className="dash-banner__drop">
                  <CodebaseDropzone
                    variant="banner"
                    disabled={!isAuthed || !allowSignal}
                    onOpenCreate={() => {
                      if (!isAuthed) {
                        router.push("/login");
                        return;
                      }
                      if (!allowSignal) return;
                      setCreateOpen(true);
                    }}
                    onOpenArchiveLink={() => {
                      if (!isAuthed) {
                        router.push("/login");
                        return;
                      }
                      if (!allowSignal) return;
                      setCreateOpen(true);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="dash-main">
              <div className="dash-right">
            <div className="dash-section">
              <div className="dash-section__header">
                <div>
                  <div className="dash-section__title">Projects</div>
                  <div className="dash-section__subtitle">
                    {loadingProjects
                      ? "Loading projects..."
                      : projectsCount === 0
                        ? "No codebases yet."
                        : `${projectsCount} codebase${projectsCount === 1 ? "" : "s"}.`}
                  </div>
                </div>
                <button
                  type="button"
                  className="dash-btn dash-btn--secondary"
                  disabled={!isAuthed || !allowSignal}
                  onClick={() => {
                    if (!isAuthed) {
                      router.push("/login");
                      return;
                    }
                    if (!allowSignal) return;
                    setCreateOpen(true);
                  }}
                >
                  Add codebase
                </button>
              </div>

              {loadingProjects ? (
                <div className="dash-project-skeleton">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="dash-project-skeleton__card" style={{ animationDelay: `${i * 120}ms` }}>
                      <div className="dash-project-skeleton__row">
                        <div className="dash-skel dash-skel--title" />
                        <div className="dash-skel dash-skel--link" />
                      </div>
                      <div className="dash-skel dash-skel--desc" />
                      <div className="dash-project-skeleton__row">
                        <div className="dash-skel dash-skel--pill" />
                        <div className="dash-skel dash-skel--pill" />
                        <div className="dash-skel dash-skel--btn" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : projects.length === 0 ? (
                <div className="dash-empty dash-projects-enter">
                  <div className="dash-empty__title">Start by adding a GitHub repo</div>
                  <div className="dash-empty__subtitle">
                    Click &quot;Add codebase&quot; and enter the GitHub URL, project name, and optional team members.
                  </div>
                </div>
              ) : (
                <div className="dash-project-list dash-projects-enter">
                  {projects.map((p) => (
                      <div key={p.id} className="dash-project-card">
                        <div className="dash-project-card__top">
                          <div className="dash-project-card__name">{p.projectName}</div>
                          <div
                            className="dash-project-card__topRight"
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-end",
                              gap: "0.5rem",
                              minWidth: 220,
                            }}
                          >
                            <a
                              className="dash-project-card__link"
                              href={p.githubUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <span className="dash-project-card__linkIcon" aria-hidden="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.1.82-.26.82-.58v-2.17c-3.34.73-4.04-1.61-4.04-1.61-.55-1.37-1.34-1.74-1.34-1.74-1.1-.75.08-.73.08-.73 1.2.09 1.84 1.22 1.84 1.22 1.07 1.82 2.8 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.9 0-1.3.47-2.36 1.24-3.2-.13-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.22a11.5 11.5 0 0 1 6 0c2.28-1.54 3.29-1.22 3.29-1.22.66 1.64.25 2.86.12 3.16.77.84 1.24 1.9 1.24 3.2 0 4.59-2.8 5.6-5.48 5.9.43.37.81 1.1.81 2.22v3.3c0 .32.21.69.83.57A12 12 0 0 0 12 .5Z" />
                                </svg>
                              </span>
                              {shortUrl(p.githubUrl)}
                            </a>
                          </div>
                        </div>
                        {p.description ? (
                          <div className="dash-project-card__desc">{p.description}</div>
                        ) : (
                          <div className="dash-project-card__desc dash-project-card__desc--muted">
                            No description yet.
                          </div>
                        )}
                        <div className="dash-project-card__layout">
                          <div className="dash-project-card__btnRow">
                            <span className="dash-team__pill">
                              Scan:{" "}<span className={`dash-scanStatus dash-scanStatus--${p.latestScanStatus ?? "not_started"}`}>{p.latestScanStatus ?? "not started"}</span>
                            </span>
                            <button
                              type="button"
                              className="dash-btn dash-btn--secondary"
                              disabled={!!scanBusy[p.id]}
                              onClick={async () => {
                                setScanBusy((s) => ({ ...s, [p.id]: true }));
                                try {
                                    const r = await fetch(`/api/projects/${p.id}/scan`, {
                                    method: "POST",
                                    headers: { "content-type": "application/json" },
                                    credentials: "include",
                                    cache: "no-store",
                                  });
                                  const json = await readApiResponse(r);
                                  if (!r.ok) throw new Error(json?.error || "Scan failed");
                                  await loadProjects({ silent: true });
                                  if (json?.scanId) {
                                    await waitForScanCompletion(p.id, String(json.scanId));
                                    await loadProjects({ silent: true });
                                    router.push(`/findingsreport/${p.id}?scanId=${encodeURIComponent(String(json.scanId))}`);
                                  }
                                } catch (err) {
                                  alert(err instanceof Error ? err.message : "Scan failed");
                                } finally {
                                  setScanBusy((s) => ({ ...s, [p.id]: false }));
                                }
                              }}
                            >
                              {scanBusy[p.id] ? "Scanning..." : "Run scan"}
                            </button>
                            {p.latestScanStatus && p.latestScanStatus !== "not started" && (
                            <button
                              type="button"
                              className="dash-btn dash-btn--secondary"
                              onClick={() => {
                                router.push(`/findingsreport/${p.id}`);
                              }}
                            >
                              View findings
                            </button>
                            )}
                            <button
                              type="button"
                              className="dash-btn dash-btn--secondary"
                              onClick={() => {
                                router.push(`/compliance/${p.id}`);
                              }}
                            >
                              Compliance
                            </button>
                            <button
                              type="button"
                              className="dash-btn dash-btn--delete-trigger"
                              disabled={!!deleteBusy[p.id]}
                              onClick={() => setDeleteTarget(p)}
                            >
                              {deleteBusy[p.id] ? (
                                <>
                                  <span className="dash-delete__spinner dash-delete__spinner--inline" aria-hidden="true" />
                                  Deleting…
                                </>
                              ) : "Delete"}
                            </button>
                          </div>
                          <div
                            className="dash-project-card__gauge"
                            aria-label={`Latest scan score ${p.securityScore ?? "N/A"}`}
                          >
                            {(() => {
                              const scoreClamped = clampScore50(p.securityScore);
                              const tone = scoreGaugeTone(scoreClamped);
                              const isZero = scoreClamped === 0;
                              const percent = scoreClamped == null ? 0 : (scoreClamped / 50) * 100;
                              const scoreInt = scoreClamped == null ? null : Math.round(Number(scoreClamped));
                              const green = "#52d6a2";
                              const toneColor =
                                isZero
                                  ? green
                                  : tone === "strong"
                                    ? green
                                    : tone === "warn"
                                      ? "#f5b84f"
                                      : tone === "critical"
                                        ? "#ff5b5b"
                                        : "rgba(255, 230, 220, 0.55)";
                              const trackColor = "rgba(255, 255, 255, 0.09)";
                              const r = 42;
                              const stroke = 8;
                              const cx = 48;
                              const size = 96;
                              const circumference = 2 * Math.PI * r;
                              /* Score 0: full green ring (0% fill would hide the arc otherwise) */
                              const dashOffset = isZero ? 0 : circumference * (1 - percent / 100);
                              return (
                                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
                                  <circle cx={cx} cy={cx} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
                                  <circle
                                    cx={cx}
                                    cy={cx}
                                    r={r}
                                    fill="none"
                                    stroke={toneColor}
                                    strokeWidth={stroke}
                                    strokeLinecap="round"
                                    strokeDasharray={`${circumference} ${circumference}`}
                                    strokeDashoffset={dashOffset}
                                    transform={`rotate(-90 ${cx} ${cx})`}
                                  />
                                  <circle cx={cx} cy={cx} r={r - stroke / 2 - 2} fill="rgba(14, 8, 8, 0.95)" stroke="rgba(255, 255, 255, 0.08)" strokeWidth="1" />
                                  <text x={cx} y="45" textAnchor="middle" dominantBaseline="middle" fill="#fef8f6" fontSize="30" fontWeight="900">{scoreInt == null ? "--" : scoreInt}</text>
                                  <text x={cx} y="62" textAnchor="middle" dominantBaseline="middle" fill="rgba(255, 220, 210, 0.78)" fontSize="12" fontWeight="850">/ 50</text>
                                </svg>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
              </div>
            </div>
          </>
        ) : activeSection === "teams" ? (
          <section className="dash-teamPanel" id="teams">
            <div className="dash-section">
              <div className="dash-section__header">
                <div>
                  <div className="dash-section__title">Team</div>
                  <div className="dash-section__subtitle">Manage team members and settings</div>
                </div>
              </div>

              <div className="dash-teamTabs" role="tablist" aria-label="Team section tabs">
                <button
                  type="button"
                  className={teamView === "members" ? "dash-teamTabs__tab dash-teamTabs__tab--active" : "dash-teamTabs__tab"}
                  onClick={() => setTeamView("members")}
                >
                  Members
                </button>
                <button
                  type="button"
                  className={teamView === "settings" ? "dash-teamTabs__tab dash-teamTabs__tab--active" : "dash-teamTabs__tab"}
                  onClick={() => setTeamView("settings")}
                >
                  Settings
                </button>
              </div>

              {teamView === "members" ? (
                <>
                  <form
                    className="dash-teamForm"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setTeamError(null);
                      if (!isAuthed) {
                        setTeamError("Log in first to invite team members.");
                        return;
                      }
                      const email = normalizeEmail(teamInvite);
                      if (!email || !email.includes("@") || !email.includes(".")) {
                        setTeamError("Please enter a valid email.");
                        return;
                      }
                      if (teamMembers.some((m) => m.email === email)) {
                        setTeamError("This member is already added.");
                        return;
                      }
                      const nowIso = new Date().toISOString();
                      setTeamMembers((prev) => [...prev, { email, createdAt: nowIso, updatedAt: nowIso }]);
                      setTeamInvite("");
                    }}
                  >
                    <input
                      className="dash-input"
                      placeholder="teammate@company.com"
                      value={teamInvite}
                      onChange={(e) => setTeamInvite(e.target.value)}
                      disabled={!isAuthed}
                    />
                    <button type="submit" className="dash-btn dash-btn--secondary" disabled={!isAuthed}>
                      Invite
                    </button>
                  </form>
                  {teamError ? (
                    <div className="dash-inline-error" role="alert">
                      {teamError}
                    </div>
                  ) : null}

                  <div className="dash-teamTableWrap">
                    <table className="dash-teamTable">
                      <thead>
                        <tr>
                          <th>Avatar</th>
                          <th>Username</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Created At</th>
                          <th>Updated At</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamMembers.map((member) => (
                          <tr key={member.email}>
                            <td>
                              <span className="dash-avatar">{usernameFromEmail(member.email).slice(0, 1).toUpperCase()}</span>
                            </td>
                            <td>{usernameFromEmail(member.email)}</td>
                            <td>{member.email}</td>
                            <td>
                              <span className="dash-teamRole">{member.email === ownerEmail ? "OWNER" : "MEMBER"}</span>
                            </td>
                            <td>{timeAgo(member.createdAt)}</td>
                            <td>{timeAgo(member.updatedAt)}</td>
                            <td>
                              {member.email === ownerEmail ? (
                                <span className="dash-teamTable__muted">-</span>
                              ) : (
                                <button
                                  type="button"
                                  className="dash-btn dash-btn--secondary"
                                  onClick={() => setTeamMembers((prev) => prev.filter((m) => m.email !== member.email))}
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="dash-empty">
                  <div className="dash-empty__title">Team settings</div>
                  <div className="dash-empty__subtitle">
                    Organization roles, permission scopes, and environment-level access controls can be added here next.
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : activeSection === "audit" ? (
          <section className="dash-teamPanel" id="audit">
            <div className="dash-section">
              <div className="dash-section__header">
                <div>
                  <div className="dash-section__title">Audit</div>
                  <div className="dash-section__subtitle">Scan history and diff summaries</div>
                </div>

                {projects.length > 0 ? (
                  <AuditProjectDropdown
                    projects={projects}
                    value={auditProject?.id ?? ""}
                    onChange={setAuditProjectId}
                  />
                ) : null}
              </div>

              {auditLoading ? (
                <div className="dash-auditLoading">Loading audit…</div>
              ) : auditError ? (
                <div className="dash-inline-error" role="alert">
                  {auditError}
                </div>
              ) : auditEntries.length === 0 ? (
                <div className="dash-empty">
                  <div className="dash-empty__title">No scans yet</div>
                  <div className="dash-empty__subtitle">Run a scan from the Projects list to generate audit diffs.</div>
                </div>
              ) : (
                <div className="dash-auditList">
                  {auditEntries.map((entry) => {
                    const when = entry.finishedAt ?? entry.createdAt;
                    const isYou = entry.ranByUserId && currentUserId && entry.ranByUserId === currentUserId;
                    const ranByLabel =
                      (typeof entry.ranByDisplayName === "string" && entry.ranByDisplayName.trim()) ||
                      (isYou ? String(displayName) : "") ||
                      (entry.ranByUserId ? entry.ranByUserId.slice(0, 8) : "Unknown");
                    const added = entry.diff?.addedCount ?? 0;
                    const removed = entry.diff?.removedCount ?? 0;
                    const changed = entry.diff?.changedCount ?? 0;

                    return (
                      <details key={entry.scanId} className="dash-auditEntry">
                        <summary className="dash-auditSummary">
                          <div className="dash-auditSummary__main">
                            <div className="dash-auditWhen">{formatDateTime(when) || when}</div>
                            <div className="dash-auditMeta">
                              <span className="dash-auditBy">
                                Ran by:{" "}
                                <span className="dash-auditRanBy">
                                  <span className="dash-auditRanByIcon" aria-hidden="true">
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.8"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                      <circle cx="12" cy="7" r="4" />
                                    </svg>
                                  </span>
                                  <span className={isYou ? "dash-auditYou" : "dash-auditRanByName"}>{ranByLabel}</span>
                                </span>
                              </span>
                              <span className="dash-auditSep">·</span>
                              <span className="dash-auditId">ID: {entry.scanId.slice(0, 8)}</span>
                            </div>
                          </div>

                          <div className="dash-auditSummary__side">
                            <div className="dash-auditScoreRow">
                              <span className="dash-auditScore">Score: {entry.securityScore ?? "N/A"}</span>
                              {entry.scoreDelta != null ? (
                                <span
                                  className={
                                    entry.scoreDelta >= 0
                                      ? "dash-auditDelta dash-auditDelta--up"
                                      : "dash-auditDelta dash-auditDelta--down"
                                  }
                                >
                                  {entry.scoreDelta >= 0 ? `+${entry.scoreDelta}` : entry.scoreDelta}
                                </span>
                              ) : (
                                <span className="dash-auditDelta dash-auditDelta--neutral">-</span>
                              )}
                            </div>

                            {entry.diff ? (
                              <div className="dash-auditBadges">
                                <span className="dash-auditBadge dash-auditBadge--added">+{added} added</span>
                                <span className="dash-auditBadge dash-auditBadge--removed">-{removed} removed</span>
                                <span className="dash-auditBadge dash-auditBadge--changed">{changed} changed</span>
                              </div>
                            ) : (
                              <div className="dash-auditBadges dash-auditBadges--empty">No previous scan for diff.</div>
                            )}

                            {entry.prUrl ? (
                              <button
                                type="button"
                                className="dash-btn dash-btn--secondary"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();

                                  const prTitle = "Signal Bot Pull Request";
                                  const body = [
                                    `Signal Bot created a pull request for this scan.`,
                                    "",
                                    `PR URL: ${entry.prUrl}`,
                                    "",
                                    "What to do next:",
                                    "1) Open the PR and review the changed files + security fixes.",
                                    "2) Run CI/tests and verify it passes.",
                                    "3) Approve and merge when validation is complete.",
                                    "4) Re-run a scan after merge to confirm risk reduction.",
                                  ].join("\n");

                                  window.alert(`${prTitle}\n\n${body}`);
                                }}
                              >
                                View
                              </button>
                            ) : null}
                          </div>
                        </summary>

                        {entry.diff ? (
                          <div className="dash-auditBody">
                            <div className="dash-auditBody__row">
                              <span className="dash-auditBody__label">Scan ID</span>
                              <span className="dash-auditMono">{entry.scanId}</span>
                            </div>

                            <div className="dash-auditDiffGrid">
                              <div className="dash-auditDiffCol dash-auditDiffCol--added">
                                <div className="dash-auditDiffCol__title">New</div>
                                {entry.diff.topAdded.length ? (
                                  <ul className="dash-auditFindingList">
                                    {entry.diff.topAdded.map((f) => (
                                      <li key={f.fingerprint}>
                                        <span className="dash-auditSeverity">{f.severity}</span> {f.category}
                                        <div className="dash-auditMono dash-auditFile">
                                          {f.filePath}
                                          {f.lineNumber != null ? `:${f.lineNumber}` : ""}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="dash-auditNone">None</div>
                                )}
                              </div>

                              <div className="dash-auditDiffCol dash-auditDiffCol--removed">
                                <div className="dash-auditDiffCol__title">Resolved</div>
                                {entry.diff.topRemoved.length ? (
                                  <ul className="dash-auditFindingList">
                                    {entry.diff.topRemoved.map((f) => (
                                      <li key={f.fingerprint}>
                                        <span className="dash-auditSeverity">{f.severity}</span> {f.category}
                                        <div className="dash-auditMono dash-auditFile">
                                          {f.filePath}
                                          {f.lineNumber != null ? `:${f.lineNumber}` : ""}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="dash-auditNone">None</div>
                                )}
                              </div>

                              <div className="dash-auditDiffCol dash-auditDiffCol--changed">
                                <div className="dash-auditDiffCol__title">Changed</div>
                                {entry.diff.topChanged.length ? (
                                  <ul className="dash-auditFindingList">
                                    {entry.diff.topChanged.map((f) => (
                                      <li key={f.fingerprint}>
                                        <span className="dash-auditSeverity">{f.severity}</span> {f.category}
                                        <div className="dash-auditMono dash-auditFile">
                                          {f.filePath}
                                          {f.lineNumber != null ? `:${f.lineNumber}` : ""}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="dash-auditNone">None</div>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        ) : activeSection === "memory" ? (
          <section className="dash-teamPanel dash-memoryStage" id="memory">
            <div className="dash-teamTabs" role="tablist" aria-label="Memory view tabs">
              <button
                type="button"
                className={memoryView === "graph" ? "dash-teamTabs__tab dash-teamTabs__tab--active" : "dash-teamTabs__tab"}
                onClick={() => setMemoryView("graph")}
              >
                Knowledge Graph
              </button>
              <button
                type="button"
                className={memoryView === "table" ? "dash-teamTabs__tab dash-teamTabs__tab--active" : "dash-teamTabs__tab"}
                onClick={() => setMemoryView("table")}
              >
                Table
              </button>
              <button
                type="button"
                className={memoryView === "vectors" ? "dash-teamTabs__tab dash-teamTabs__tab--active" : "dash-teamTabs__tab"}
                onClick={() => setMemoryView("vectors")}
              >
                Vector DB
              </button>
            </div>

            {memoryView === "graph" ? (
              <MemoryMapPanel key={memoryProject?.id ?? "none"} projectId={memoryProject?.id} projectName={memoryProject?.projectName} />
            ) : memoryView === "table" ? (
              <MemoryTablePanel projectId={memoryProject?.id} />
            ) : (
              <VectorExplorerPanel projectId={memoryProject?.id} />
            )}
          </section>
        ) : (
          <section className="dash-teamPanel" id="webhooks">
            <div className="dash-section">
              <div className="dash-section__header">
                <div>
                  <div className="dash-section__title">Webhooks</div>
                  <div className="dash-section__subtitle">Connect Discord alerts for scans, resolves, and new projects</div>
                </div>
              </div>

              {!isAuthed ? (
                <div className="dash-inline-error" role="alert">
                  Log in first to manage webhook settings.
                </div>
              ) : (
                <form
                  className="dash-teamForm"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setWebhookError(null);
                    setWebhookNotice(null);
                    const value = webhookUrl.trim();
                    if (!value) {
                      setWebhookError("Please paste a Discord webhook URL.");
                      return;
                    }

                    setWebhookBusy(true);
                    try {
                      const r = await fetch("/api/projects/webhook", {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        credentials: "include",
                        cache: "no-store",
                        body: JSON.stringify({ webhookUrl: value }),
                      });
                      const json = await readApiResponse(r);
                      if (!r.ok) throw new Error(json?.error || "Could not save webhook");
                      setWebhookEnabled(true);
                      setWebhookNotice("Discord webhook connected.");
                    } catch (err) {
                      setWebhookError(err instanceof Error ? err.message : "Could not save webhook");
                    } finally {
                      setWebhookBusy(false);
                    }
                  }}
                >
                  <input
                    className="dash-input"
                    placeholder="https://discord.com/api/webhooks/..."
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    disabled={webhookBusy}
                  />
                  <button type="submit" className="dash-btn dash-btn--secondary" disabled={webhookBusy}>
                    {webhookBusy ? "Saving..." : "Save webhook"}
                  </button>
                  <button
                    type="button"
                    className="dash-btn"
                    disabled={webhookBusy || !webhookEnabled}
                    onClick={async () => {
                      setWebhookError(null);
                      setWebhookNotice(null);
                      setWebhookBusy(true);
                      try {
                        const r = await fetch("/api/projects/webhook", {
                          method: "DELETE",
                          credentials: "include",
                          cache: "no-store",
                        });
                        const json = await readApiResponse(r);
                        if (!r.ok) throw new Error(json?.error || "Could not disable webhook");
                        setWebhookEnabled(false);
                        setWebhookNotice("Webhook disabled.");
                      } catch (err) {
                        setWebhookError(err instanceof Error ? err.message : "Could not disable webhook");
                      } finally {
                        setWebhookBusy(false);
                      }
                    }}
                  >
                    Disable
                  </button>
                </form>
              )}

              {webhookError ? (
                <div className="dash-inline-error" role="alert">
                  {webhookError}
                </div>
              ) : null}
              {webhookNotice ? <div className="dash-auditLoading">{webhookNotice}</div> : null}
            </div>
          </section>
        )}
      </div>

      <ProjectCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (p) => {
          const r = await fetch("/api/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            cache: "no-store",
            body: JSON.stringify({
              githubUrl: p.githubUrl,
              projectName: p.projectName,
              description: p.description,
              scanOnCreate: p.scanOnCreate,
            }),
          });
          const json = await readApiResponse(r);
          if (!r.ok) {
            throw new Error(json?.error || "Could not create project");
          }
          await loadProjects({ silent: true });
          const initial = json?.initialScan as { status?: string; error?: string; skipped?: boolean } | undefined;
          if (initial?.status === "failed" && initial?.error) {
            window.alert(`Project created, but the scan could not start: ${initial.error}`);
          }
        }}
      />

      <DeleteConfirmModal
        open={!!deleteTarget}
        projectName={deleteTarget?.projectName ?? ""}
        deleting={!!deleteTarget && !!deleteBusy[deleteTarget.id]}
        onClose={() => {
          if (deleteTarget && deleteBusy[deleteTarget.id]) return;
          setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleteBusy((s) => ({ ...s, [deleteTarget.id]: true }));
          try {
            const r = await fetch(`/api/projects/${deleteTarget.id}`, {
              method: "DELETE",
              credentials: "include",
              cache: "no-store",
            });
            const json = await readApiResponse(r);
            if (!r.ok) throw new Error(json?.error || "Delete failed");
            setDeleteTarget(null);
            await loadProjects();
          } catch (err) {
            alert(err instanceof Error ? err.message : "Delete failed");
          } finally {
            setDeleteBusy((s) => ({ ...s, [deleteTarget.id]: false }));
          }
        }}
      />

      <nav className="dash-bottomnav" aria-label="Dashboard navigation">
        <Link
          href="/dashboard"
          className={activeSection === "home" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          aria-current={activeSection === "home" ? "page" : undefined}
          onClick={() => setActiveSection("home")}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 10v11h14V10" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Home</span>
        </Link>

        <Link
          href="/dashboard#teams"
          className={activeSection === "teams" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          onClick={() => setActiveSection("teams")}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M23 7a4 4 0 0 0-7.73-1.6" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Teams</span>
        </Link>

        <Link
          href="/dashboard#audit"
          className={activeSection === "audit" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          onClick={() => setActiveSection("audit")}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Audit</span>
        </Link>

        <Link
          href="/dashboard#memory"
          className={activeSection === "memory" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          onClick={() => setActiveSection("memory")}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="9" r="2.2" />
              <circle cx="17" cy="7" r="2.2" />
              <circle cx="15" cy="17" r="2.2" />
              <path d="M9 10.2 13.5 7.5" />
              <path d="M13.5 16 15.8 15" />
              <path d="M9 10.2 13.8 16.2" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Memory</span>
        </Link>

        <Link
          href="/dashboard#webhooks"
          className={activeSection === "webhooks" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          onClick={() => setActiveSection("webhooks")}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 16a4 4 0 0 1-4 4H8l-4 3 1.3-3.8A4 4 0 0 1 4 16V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8Z" />
              <path d="M9 12h6" />
              <path d="M9 9h3" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Webhooks</span>
        </Link>

        <button
          type="button"
          className={allowSignal ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          onClick={() => {
            if (!isAuthed) {
              router.push("/login");
              return;
            }
            if (!allowSignal) {
              localStorage.setItem(ALLOW_KEY, "1");
              setAllowSignal(true);
              return;
            }
            setCreateOpen(true);
          }}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1" />
              <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">Add Codebase</span>
        </button>
      </nav>
    </div>
  );
}

