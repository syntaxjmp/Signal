"use client";

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import styles from "./page.module.css";

type TeamMember = { email: string };
type TeamRow = { email: string; createdAt: string; updatedAt: string };

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
      `/api/projects/${projectId}/findings?page=1&pageSize=1&scanId=${encodeURIComponent(scanId)}`,
      {
        credentials: "include",
        cache: "no-store",
      },
    );
    const json = await readApiResponse(r);
    if (!r.ok) throw new Error(json?.error || "Failed to fetch scan status");
    const status = json?.summary?.status;
    if (status === "completed") return;
    if (status === "failed") {
      throw new Error(json?.summary?.errorMessage || "Scan failed");
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

function ProjectCreateModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (p: { githubUrl: string; projectName: string; description: string; teamMembers: TeamMember[] }) => Promise<void>;
}) {
  const [githubUrl, setGithubUrl] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamMembersRaw, setTeamMembersRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setError(null), 0);
    return () => window.clearTimeout(t);
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
        if (e.target === e.currentTarget) onClose();
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
          <button className="dash-modal__close" onClick={onClose} type="button">
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

            try {
              await onCreate({
                githubUrl: githubUrlTrimmed,
                projectName: nameTrimmed,
                description: description.trim(),
                teamMembers: parseTeamMembers(teamMembersRaw),
              });
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not create project");
            }
          }}
        >
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
            >
              Cancel
            </button>
            <button className="dash-btn dash-btn--primary" type="submit">
              Add project
            </button>
          </div>
        </form>
      </div>
    </div>
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

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  const isAuthed = !!session;
  const [projects, setProjects] = useState<Project[]>([]);
  const [scanBusy, setScanBusy] = useState<Record<string, boolean>>({});
  const [deleteBusy, setDeleteBusy] = useState<Record<string, boolean>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [allowSignal, setAllowSignal] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [booting, setBooting] = useState<boolean>(false);
  const [bootChecked, setBootChecked] = useState<boolean>(false);
  const [bootAnimDone, setBootAnimDone] = useState(false);
  const [initialProjectsLoaded, setInitialProjectsLoaded] = useState(false);
  const initialProjectsLoadedRef = useRef(false);
  const [activeSection, setActiveSection] = useState<"home" | "teams">("home");
  const [teamView, setTeamView] = useState<"members" | "settings">("members");
  const [teamMembers, setTeamMembers] = useState<TeamRow[]>([]);
  const [teamInvite, setTeamInvite] = useState("");
  const [teamError, setTeamError] = useState<string | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const BOOT_ANIM_MS = 1850;

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
    if (!initialProjectsLoaded) return;
    setBooting(false);
  }, [booting, bootAnimDone, initialProjectsLoaded]);

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

  const loadProjects = useCallback(async () => {
    if (!isAuthed) {
      setProjects([]);
      if (!initialProjectsLoadedRef.current) {
        initialProjectsLoadedRef.current = true;
        setInitialProjectsLoaded(true);
      }
      return;
    }
    setLoadingProjects(true);
    try {
      const r = await fetch("/api/projects", { credentials: "include", cache: "no-store" });
      const json = await readApiResponse(r);
      if (!r.ok) throw new Error(json?.error || "Failed to load projects");
      setProjects(Array.isArray(json?.data) ? json.data : []);
    } catch (e) {
      console.error("Failed to load projects", e);
      setProjects([]);
    } finally {
      setLoadingProjects(false);
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

  const projectsCount = projects.length;
  const ownerEmail = normalizeEmail(String((session as any)?.user?.email ?? ""));
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
    if (isPending) return <span className="dash-pill">Checking session…</span>;
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
          <button type="button" className="dash-user__logout" onClick={handleLogout}>
            Log out
          </button>
        ) : null}
      </div>
    );
  }, [displayName, handleLogout, isAuthed, isPending, showLogout]);

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
        <Link href="/dashboard" className="brand" aria-label="Signal Dashboard">
          <Image
            src="/signal_evenbigger.png"
            alt=""
            width={60}
            height={60}
            className="dash-brand-logo"
            priority
            aria-hidden
          />
          <div className="dash-pageTitle" aria-hidden="true">
            <span className="dash-pageTitle__signal">Signal</span>
            <span className="dash-pageTitle__sep">/</span>
            <span className="dash-pageTitle__item">
              Dashboard
            </span>
          </div>
        </Link>
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

              {projects.length === 0 ? (
                <div className="dash-empty">
                  <div className="dash-empty__title">Start by adding a GitHub repo</div>
                  <div className="dash-empty__subtitle">
                    Click “Add codebase” and enter the GitHub URL, project name, and optional team members.
                  </div>
                </div>
              ) : (
                <div className="dash-project-list">
                  {projects.map((p) => (
                      <div key={p.id} className="dash-project-card">
                        <div className="dash-project-card__top">
                          <div className="dash-project-card__name">{p.projectName}</div>
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
                        {p.description ? (
                          <div className="dash-project-card__desc">{p.description}</div>
                        ) : (
                          <div className="dash-project-card__desc dash-project-card__desc--muted">
                            No description yet.
                          </div>
                        )}
                        <div className="dash-team">
                          <span className="dash-team__pill">
                            Security Score: {p.securityScore ?? "N/A"}
                          </span>
                          <span className="dash-team__pill">
                            Scan: {p.latestScanStatus ?? "not started"}
                          </span>
                          <button
                            type="button"
                            className="dash-btn dash-btn--secondary"
                            disabled={!!scanBusy[p.id]}
                            onClick={async () => {
                              setScanBusy((s) => ({ ...s, [p.id]: true }));
                              try {
                                const key = window.prompt("OpenAI API key (leave blank to use backend OPENAI_API_KEY):", "") ?? "";
                                const r = await fetch(`/api/projects/${p.id}/scan`, {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  credentials: "include",
                                  cache: "no-store",
                                  body: JSON.stringify({ openAiApiKey: key || undefined }),
                                });
                                const json = await readApiResponse(r);
                                if (!r.ok) throw new Error(json?.error || "Scan failed");
                                if (json?.scanId) {
                                  await waitForScanCompletion(p.id, String(json.scanId));
                                  await loadProjects();
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
                          <button
                            type="button"
                            className="dash-btn dash-btn--secondary"
                            onClick={() => {
                              router.push(`/findingsreport/${p.id}`);
                            }}
                          >
                            View findings
                          </button>
                          <button
                            type="button"
                            className="dash-btn dash-btn--secondary"
                            disabled={!!deleteBusy[p.id]}
                            onClick={async () => {
                              if (!window.confirm(`Delete project "${p.projectName}"? This also removes scans and findings.`)) {
                                return;
                              }
                              setDeleteBusy((s) => ({ ...s, [p.id]: true })); 
                              try {
                                const r = await fetch(`/api/projects/${p.id}`, {
                                  method: "DELETE",
                                  credentials: "include",
                                  cache: "no-store",
                                });
                                const json = await readApiResponse(r);
                                if (!r.ok) throw new Error(json?.error || "Delete failed");
                                await loadProjects();
                              } catch (err) {
                                alert(err instanceof Error ? err.message : "Delete failed");
                              } finally {
                                setDeleteBusy((s) => ({ ...s, [p.id]: false }));
                              }
                            }}
                          >
                            {deleteBusy[p.id] ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
              </div>
            </div>
          </>
        ) : (
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
            }),
          });
          const json = await readApiResponse(r);
          if (!r.ok) {
            throw new Error(json?.error || "Could not create project");
          }
          await loadProjects();
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

        <button
          type="button"
          className="dash-bottomnav__item"
          onClick={() => {
            // UI placeholder: wire to an API-key flow when backend is ready.
            setCreateOpen(false);
            router.push("/dashboard");
          }}
        >
          <span className="dash-bottomnav__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2" />
              <path d="M7.5 2.5a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L6 11l-4 1 1-4 4.5-5.5Z" />
              <path d="M15 8l1 1" />
              <path d="M4 20l4-4" />
            </svg>
          </span>
          <span className="dash-bottomnav__label">API Key</span>
        </button>

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
          <span className="dash-bottomnav__label">Connect</span>
        </button>
      </nav>
    </div>
  );
}

