"use client";

import type { CSSProperties } from "react";
import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";

const accordionItems = [
  {
    key: "scan",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7V5a2 2 0 0 1 2-2h2" />
        <path d="M17 3h2a2 2 0 0 1 2 2v2" />
        <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
        <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
        <line x1="4" y1="12" x2="20" y2="12" />
      </svg>
    ),
    title: "Scan.",
    description: "Detect vulnerabilities across your entire frontend in seconds.",
    bullets: [
      "One-click scanning for any project.",
      "Covers dependencies, configs, and source code.",
      "Results ranked by severity and exploitability.",
    ],
  },
  {
    key: "analyze",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-9-9" />
        <path d="M21 3v6h-6" />
        <path d="M12 12l4-4" />
      </svg>
    ),
    title: "Analyze.",
    description: "Understand the impact and context behind every finding.",
    bullets: [
      "Contextual risk scoring with business impact.",
      "Dependency graph visualization.",
      "Actionable fix suggestions with code diffs.",
    ],
  },
  {
    key: "monitor",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10" />
        <path d="M12 12l3-3" />
        <circle cx="12" cy="12" r="1" />
        <path d="M18 6l4-4" />
      </svg>
    ),
    title: "Monitor.",
    description: "Stay protected with continuous, real-time monitoring.",
    bullets: [
      "Automated re-scans on every deploy.",
      "Instant alerts for newly disclosed CVEs.",
      "Team-wide dashboards with trend tracking.",
    ],
  },
  {
    key: "report",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <line x1="10" y1="9" x2="8" y2="9" />
      </svg>
    ),
    title: "Report.",
    description: "Generate compliance-ready reports your team can act on.",
    bullets: [
      "Export to PDF, JSON, or integrate via API.",
      "Meets SOC 2, ISO 27001, and OWASP standards.",
      "Share findings with stakeholders in one click.",
    ],
  },
];

export default function Home() {
  const bars = [
    0.18, 0.22, 0.28, 0.35, 0.46, 0.58, 0.46, 0.35, 0.28, 0.22, 0.31, 0.44,
    0.58, 0.46, 0.35, 0.28, 0.18, 0.12,
  ];

  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <main className="landing">
      <section className="landing-surface">
        <div className="iso-grid" aria-hidden="true" />
        <div className="vignette" aria-hidden="true" />

        <header className="top-nav">
          <Link href="/" className="brand" aria-label="Signal home">
            <Image
              src="/signal_evenbigger.png"
              alt=""
              width={160}
              height={160}
              className="brand-logo"
              priority
              aria-hidden
            />
            Signal
          </Link>

          <nav className="nav-links" aria-label="Primary">
            <a href="#">About Us</a>
            <a href="#">Blog</a>
            <a href="#">Resources</a>
            <Link href="/login">Log in</Link>
            <Link href="/signup">Sign up</Link>
            <a className="social-box" href="#" aria-label="X">
              X
            </a>
            <a className="social-box" href="#" aria-label="LinkedIn">
              in
            </a>
          </nav>
        </header>

        <section className="hero">
          <div className="hero__content">
            <h1>
              Ship faster,
              <br />
              Without Stress.
            </h1>
            <p>
              Signal enables developers to ship quickly and securely by detecting critical
              vulnerabilities instantly, all in a single click.
            </p>
            <div className="hero-actions">
              <a className="action action-primary" href="#features">
                Stay up to Speed
              </a>
              <a className="action action-secondary" href="#">
                Read Documentation
              </a>
            </div>
          </div>
        </section>

        <section className="bars" aria-hidden="true">
          {bars.map((height, index) => (
            <span
              key={`${height}-${index}`}
              className="bar"
              style={
                {
                  "--height": String(height),
                  "--delay": `${index * 90}ms`,
                } as CSSProperties
              }
            />
          ))}
        </section>
      </section>

      {/* Architecture Diagram */}
      <section className="arch">
        <div className="arch__inner">
          <svg style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden="true">
            <defs>
              <marker
                id="arch-diamond"
                viewBox="0 0 12 12"
                refX="6"
                refY="6"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M6,1 L11,6 L6,11 L1,6 Z" fill="rgba(255,113,87,0.45)" />
              </marker>
            </defs>
          </svg>

          <div className="arch__tagline">
            <Image
              src="/signal_bigger.png"
              alt=""
              width={56}
              height={56}
              className="arch__logo"
              style={{ width: "auto", height: "auto" }}
            />
            <p>One Scan. Complete Coverage.</p>
          </div>

          <div className="arch__diagram">
            {/* Left: Inputs */}
            <div className="arch__col">
              <div>
                <h3 className="arch__col-label">Frameworks</h3>
                <div className="arch__icon-grid">
                  {[
                    { glyph: "⚛", name: "React" },
                    { glyph: "◆", name: "Vue" },
                    { glyph: "▲", name: "Angular" },
                  ].map((fw) => (
                    <div key={fw.name} className="arch__icon-cell">
                      <span className="arch__icon-glyph">{fw.glyph}</span>
                      <span className="arch__icon-name">{fw.name}</span>
                    </div>
                  ))}
                  <svg className="arch__curve arch__curve--l1" viewBox="0 0 100 70">
                    <path
                      className="arch__curve-line"
                      d="M0,35 C30,35 70,35 100,35"
                      markerEnd="url(#arch-diamond)"
                    />
                    <path className="arch__curve-glow" d="M0,35 C30,35 70,35 100,35" />
                  </svg>
                </div>
              </div>
              <div>
                <h3 className="arch__col-label">Build Tools</h3>
                <div className="arch__icon-grid">
                  {[
                    { glyph: "⚡", name: "Vite" },
                    { glyph: "📦", name: "Webpack" },
                    { glyph: "✓", name: "ESLint" },
                  ].map((tool) => (
                    <div key={tool.name} className="arch__icon-cell">
                      <span className="arch__icon-glyph">{tool.glyph}</span>
                      <span className="arch__icon-name">{tool.name}</span>
                    </div>
                  ))}
                  <svg className="arch__curve arch__curve--l2" viewBox="0 0 100 70">
                    <path
                      className="arch__curve-line"
                      d="M0,35 C30,35 70,35 100,35"
                      markerEnd="url(#arch-diamond)"
                    />
                    <path className="arch__curve-glow" d="M0,35 C30,35 70,35 100,35" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Center: Security Panels */}
            <div className="arch__panels-wrap">
              <div className="arch__zone">
                <div className="arch__panels">
                  {[
                    {
                      label: "Dependency Scanning",
                      desc: "Deep analysis of npm, yarn, and pnpm packages for known CVEs and advisories.",
                      z: 1,
                    },
                    {
                      label: "Code Analysis",
                      desc: "Static analysis of source code for security anti-patterns and injection risks.",
                      z: 2,
                    },
                    {
                      label: "Config Auditing",
                      desc: "Review build configs, environment variables, and deployment settings for leaks.",
                      z: 4,
                    },
                    {
                      label: "Vulnerability Detection",
                      desc: "Comprehensive detection across your entire frontend codebase, dependencies, and configurations.",
                      z: 7,
                    },
                    {
                      label: "Compliance Mapping",
                      desc: "Map findings to SOC 2, ISO 27001, and OWASP standards automatically.",
                      z: 4,
                    },
                    {
                      label: "Runtime Monitoring",
                      desc: "Continuous monitoring with instant alerts when new threats are disclosed.",
                      z: 2,
                    },
                    {
                      label: "Threat Reports",
                      desc: "Generate compliance-ready reports and share findings in one click.",
                      z: 1,
                    },
                  ].map((panel) => (
                    <div
                      key={panel.label}
                      className="arch__panel"
                      style={{ "--panel-i": panel.z } as CSSProperties}
                    >
                      <div>
                        {panel.label}
                        <p className="arch__panel-desc">{panel.desc}</p>
                        <span className="arch__panel-link">
                          Learn more <span aria-hidden="true">→</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <p className="arch__platform-label">Frontend Security Platform</p>
            </div>

            {/* Right: Outputs */}
            <div className="arch__col">
              {[
                {
                  title: "CI/CD",
                  pills: ["GitHub Actions", "GitLab CI", "Jenkins"],
                  curve: "r1",
                },
                {
                  title: "Issue Tracking",
                  pills: ["Jira", "Linear", "Asana"],
                },
                {
                  title: "Alerting",
                  pills: ["Slack", "Teams", "Discord"],
                  curve: "r2",
                },
                {
                  title: "Compliance",
                  pills: ["SOC 2", "ISO 27001", "OWASP"],
                },
                {
                  title: "APIs & Webhooks",
                  pills: ["Webhooks"],
                  curve: "r3",
                },
              ].map((block) => (
                <div key={block.title} className="arch__output-block">
                  <h4>{block.title}</h4>
                  <div className="arch__output-pills">
                    {block.pills.map((pill) => (
                      <span key={pill} className="arch__output-pill">
                        {pill}
                      </span>
                    ))}
                  </div>
                  {block.curve && (
                    <svg
                      className={`arch__curve arch__curve--${block.curve}`}
                      viewBox="0 0 100 70"
                    >
                      <path
                        className="arch__curve-line"
                        d="M100,35 C70,35 30,35 0,35"
                        markerStart="url(#arch-diamond)"
                      />
                      <path className="arch__curve-glow" d="M100,35 C70,35 30,35 0,35" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="features" id="features">
        <div className="features__inner">
          <h2 className="features__heading">
            Scan, analyze, monitor &amp; report
            <br />
            your security across every project.
          </h2>

          <div className="features__split">
            <div className="features__visual">
              <Image
                src="/BabaDefault_stylized_volcano_with_flowing_lava_abstract_and_m_3838cd46-84a0-4ddf-883a-b44898df5784_0.png"
                alt=""
                fill
                sizes="(max-width: 900px) 90vw, 50vw"
                className="features__visual-bg"
                aria-hidden
              />
              <div className="mac-window">
                <div className="mac-window__titlebar">
                  <span className="mac-window__dot mac-window__dot--red" />
                  <span className="mac-window__dot mac-window__dot--yellow" />
                  <span className="mac-window__dot mac-window__dot--green" />
                </div>
                <div className="mac-window__body">
                  <video
                    className="mac-window__video"
                    src="/FindingsDemo.mp4"
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                </div>
              </div>
            </div>

            <div className="features__accordion">
              {accordionItems.map((item, index) => {
                const isOpen = openIndex === index;
                return (
                  <button
                    key={item.key}
                    className={`accordion-item${isOpen ? " accordion-item--open" : ""}`}
                    onClick={() => setOpenIndex(isOpen ? null : index)}
                    aria-expanded={isOpen}
                  >
                    <div className="accordion-item__header">
                      <span className="accordion-item__icon">{item.icon}</span>
                      <span className="accordion-item__title">{item.title}</span>
                      <svg
                        className="accordion-item__chevron"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>

                    <div className="accordion-item__body">
                      <div className="accordion-item__body-inner">
                        <p className="accordion-item__desc">{item.description}</p>
                        <ul className="accordion-item__bullets">
                          {item.bullets.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <footer className="landing-footer" aria-label="Footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__top">
            <div className="landing-footer__logo" aria-hidden="true">
              <Image
                src="/signal_bigger.png"
                alt=""
                width={44}
                height={44}
                className="landing-footer__logoImg"
                priority
              />
            </div>

            <div className="landing-footer__cols">
              <div className="landing-footer__col">
                <h4 className="landing-footer__heading">Developers</h4>
                <div className="landing-footer__links">
                  <Link href="/dashboard">Dashboard</Link>
                </div>
              </div>

              <div className="landing-footer__col">
                <h4 className="landing-footer__heading">Resources</h4>
                <div className="landing-footer__links">
                  <Link href="/login">Log in</Link>
                  <Link href="/signup">Sign up</Link>
                </div>
              </div>

              <div className="landing-footer__col">
                <h4 className="landing-footer__heading">Company</h4>
                <div className="landing-footer__links">
                  <Link href="/">Home</Link>
                </div>
              </div>
            </div>
          </div>

          <div className="landing-footer__bottom">
            <div className="landing-footer__copy">
              <span className="landing-footer__copyBrand">Signal</span> © All rights reserved.
            </div>

          </div>
        </div>
      </footer>
    </main>
  );
}
