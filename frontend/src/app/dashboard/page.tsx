"use client";

import React, { startTransition, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import styles from "./page.module.css";

type TeamMember = { email: string };

type Project = {
  id: string;
  githubUrl: string;
  name: string;
  description: string;
  teamMembers: TeamMember[];
  createdAt: number;
};

const STORAGE_KEY = "signal_dashboard_projects_v1";
const ALLOW_KEY = "signal_dashboard_allow_v1";

function safeParseProjects(raw: string | null): Project[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.id === "string");
  } catch {
    return [];
  }
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

function ProjectCreateModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (p: Omit<Project, "id" | "createdAt">) => void;
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
          onSubmit={(e) => {
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

            onCreate({
              githubUrl: githubUrlTrimmed,
              name: nameTrimmed,
              description: description.trim(),
              teamMembers: parseTeamMembers(teamMembersRaw),
            });
            onClose();
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
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  const isAuthed = !!session;
  const [projects, setProjects] = useState<Project[]>([]);
  const [allowSignal, setAllowSignal] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    startTransition(() => {
      setProjects(safeParseProjects(localStorage.getItem(STORAGE_KEY)));
      setAllowSignal(localStorage.getItem(ALLOW_KEY) === "1");
    });
  }, []);

  const projectsCount = projects.length;

  const displayName =
    (session as any)?.user?.name ??
    (session as any)?.user?.username ??
    (session as any)?.user?.email ??
    "Account";

  const headerRight = useMemo(() => {
    if (isPending) return <span className="dash-pill">Checking session…</span>;
    if (!isAuthed)
      return (
        <Link className="action action-primary" href="/login">
          Log in
        </Link>
      );
    return (
      <div className="dash-user" aria-label="Signed in user">
        <span className="dash-user__icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
        <span className="dash-user__name">{String(displayName)}</span>
      </div>
    );
  }, [displayName, isAuthed, isPending]);

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
                    {projectsCount === 0 ? "No codebases yet." : `${projectsCount} codebase${projectsCount === 1 ? "" : "s"}.`}
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
                  {projects
                    .slice()
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((p) => (
                      <div key={p.id} className="dash-project-card">
                        <div className="dash-project-card__top">
                          <div className="dash-project-card__name">{p.name}</div>
                          <a
                            className="dash-project-card__link"
                            href={p.githubUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
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
                        {p.teamMembers.length ? (
                          <div className="dash-team">
                            {p.teamMembers.slice(0, 6).map((m) => (
                              <span key={m.email} className="dash-team__pill">
                                {m.email}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="dash-team dash-team--muted">
                            No team members added.
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ProjectCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(p) => {
          const newProject: Project = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            ...p,
          };
          const next = [newProject, ...projects];
          setProjects(next);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        }}
      />

      <nav className="dash-bottomnav" aria-label="Dashboard navigation">
        <Link
          href="/dashboard"
          className={pathname === "/dashboard" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
          aria-current={pathname === "/dashboard" ? "page" : undefined}
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
          href="/dashboard"
          className={pathname === "/teams" ? "dash-bottomnav__item dash-bottomnav__item--active" : "dash-bottomnav__item"}
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

