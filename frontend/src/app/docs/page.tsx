"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import styles from "./page.module.css";

const severityTable = [
  { level: "Critical", weight: 15, pressure: 4.0, color: "#ff7b7b", desc: "Directly exploitable vulnerabilities that can lead to full system compromise, data breach, or remote code execution." },
  { level: "High", weight: 10, pressure: 2.0, color: "#ff9a66", desc: "Serious vulnerabilities that require minimal conditions to exploit, such as SQL injection or authentication bypass." },
  { level: "Medium", weight: 6, pressure: 0.5, color: "#ffd089", desc: "Vulnerabilities that require specific conditions or user interaction to exploit, like XSS or insecure cookies." },
  { level: "Low", weight: 2, pressure: 0.1, color: "#79ddaa", desc: "Informational findings or best-practice violations with limited direct security impact." },
];

const vulnCategories = [
  { group: "Injection", items: ["SQL Injection", "NoSQL Injection", "Command Injection", "LDAP Injection", "XPath Injection", "XML External Entity (XXE)"] },
  { group: "Cross-Site Attacks", items: ["Reflected XSS", "Stored XSS", "DOM-based XSS", "Cross-Site Request Forgery (CSRF)", "Open Redirect"] },
  { group: "Secrets & Data Exposure", items: ["Hardcoded Secrets & Credentials", "Exposed API Keys", "AWS Access Key Material", "Private Key Material", "Sensitive Data in Logs", "Verbose Error / Stack Leak"] },
  { group: "Authentication & Authorization", items: ["Authentication Bypass", "Missing Authorization Check", "Session Fixation", "Insecure Direct Object Reference (IDOR)", "Mass Assignment"] },
  { group: "Cryptography & Transport", items: ["Weak Cryptography", "Hardcoded Cryptographic Key", "Insecure Randomness", "TLS / HTTPS Misconfiguration"] },
  { group: "Configuration & Runtime", items: ["CORS Misconfiguration", "Insecure Cookie Flags", "Insecure Deserialization", "Unsafe File Upload", "Path Traversal", "Server-Side Request Forgery (SSRF)"] },
  { group: "Code Quality & Dependencies", items: ["Dangerous Dynamic Code Execution (eval)", "Prototype Pollution", "Regular Expression DoS (ReDoS)", "Race Condition / TOCTOU", "Vulnerable Dependency"] },
];

const scanSteps = [
  { num: "01", title: "Repository Ingestion", desc: "Signal connects to your GitHub repository and downloads the source code securely. Private repos are supported via personal access tokens." },
  { num: "02", title: "File Discovery & Prioritization", desc: "We recursively walk your codebase, collecting source files across 20+ languages. Files are prioritized by security relevance — auth modules, database layers, API routes, and config files are analyzed first." },
  { num: "03", title: "Intelligent Chunking", desc: "Each file is split into overlapping 60-line windows with 40-line steps, ensuring no vulnerability that spans a boundary is missed. Import context is extracted separately for each file." },
  { num: "04", title: "AI-Powered Analysis", desc: "Every code snippet is analyzed by our security-tuned AI model, which has been instructed with deep knowledge of OWASP Top 10, CWE patterns, and real-world exploit chains. The model evaluates each snippet for vulnerabilities, assigns severity, and provides a description." },
  { num: "05", title: "False Positive Filtering", desc: "Our system applies strict false-positive rules: parameterized queries, proper password hashing (bcrypt/argon2), environment variable reads, test fixtures, and commented-out code are all excluded automatically." },
  { num: "06", title: "Deduplication & Scoring", desc: "Findings are deduplicated using cryptographic fingerprints, then each is assigned a weighted score. The overall security score is computed using an exponential risk model that accounts for both volume and severity pressure." },
];

const fpRules = [
  "Parameterized SQL queries (?, $1, named placeholders)",
  "Industry-standard password hashing (bcrypt, argon2, scrypt, PBKDF2)",
  "Environment variable reads (process.env, os.environ, etc.)",
  "Test fixtures with dummy/mock credentials",
  "Commented-out code blocks",
  "Console.log statements (unless logging secrets or PII)",
  "HTTPS URLs and secure imports",
  "Importing security libraries (helmet, cors, csurf, etc.)",
];

export default function DocsPage() {
  return (
    <main className={`docs ${styles.root}`}>
      <div className="docs-topnav">
        <Link href="/" className="docs-brand" aria-label="Signal home">
          <Image
            src="/signal_evenbigger.png"
            alt=""
            width={60}
            height={60}
            className="docs-brand__logo"
            priority
            aria-hidden
          />
          <div className="docs-brand__title" aria-hidden="true">
            <span className="docs-brand__signal">Signal</span>
            <span className="docs-brand__sep">/</span>
            <span className="docs-brand__item">Docs</span>
          </div>
        </Link>
        <Link href="/" className="docs-btn docs-btn--ghost">
          Back to home
        </Link>
      </div>

      <div className="docs-shell">
        <header className="docs-hero">
          <h1 className="docs-hero__title">Documentation</h1>
          <p className="docs-hero__sub">
            Everything you need to know about how Signal scans your code, detects vulnerabilities, and scores your security posture.
          </p>
        </header>

        {/* Table of contents */}
        <nav className="docs-toc docs-card docs-fadein">
          <div className="docs-card__label">On this page</div>
          <ul className="docs-toc__list">
            <li><a href="#how-it-works">How the Scanner Works</a></li>
            <li><a href="#vulnerability-categories">Vulnerability Categories</a></li>
            <li><a href="#severity-levels">Severity Levels & Weights</a></li>
            <li><a href="#scoring">Security Score Calculation</a></li>
            <li><a href="#false-positives">False Positive Prevention</a></li>
            <li><a href="#supported-languages">Supported Languages</a></li>
            <li><a href="#resolution">Automated Resolution</a></li>
          </ul>
        </nav>

        {/* How it works */}
        <section id="how-it-works" className="docs-section docs-fadein">
          <h2 className="docs-section__title">How the Scanner Works</h2>
          <p className="docs-section__intro">
            Signal uses AI-powered static analysis to find real, exploitable vulnerabilities in your codebase.
            Here is what happens when you hit &quot;Scan&quot;:
          </p>
          <div className="docs-steps">
            {scanSteps.map((step) => (
              <div key={step.num} className="docs-step">
                <div className="docs-step__num">{step.num}</div>
                <div className="docs-step__body">
                  <h3 className="docs-step__title">{step.title}</h3>
                  <p className="docs-step__desc">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Vulnerability categories */}
        <section id="vulnerability-categories" className="docs-section docs-fadein">
          <h2 className="docs-section__title">Vulnerability Categories</h2>
          <p className="docs-section__intro">
            Signal detects <strong>35+ vulnerability types</strong> across 7 major categories, aligned with the OWASP Top 10 and CWE standards.
          </p>
          <div className="docs-catGrid">
            {vulnCategories.map((cat) => (
              <div key={cat.group} className="docs-card docs-catCard">
                <div className="docs-catCard__group">{cat.group}</div>
                <ul className="docs-catCard__list">
                  {cat.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Severity levels */}
        <section id="severity-levels" className="docs-section docs-fadein">
          <h2 className="docs-section__title">Severity Levels &amp; Weights</h2>
          <p className="docs-section__intro">
            Every finding is assigned one of four severity levels. Each level carries a base weight used in scoring
            and a pressure multiplier that amplifies the impact of repeated findings at that severity.
          </p>
          <div className="docs-sevTable">
            <div className="docs-sevTable__header">
              <span>Severity</span>
              <span>Weight</span>
              <span>Pressure</span>
              <span>Description</span>
            </div>
            {severityTable.map((row) => (
              <div key={row.level} className="docs-sevTable__row">
                <span className="docs-sevTable__level" style={{ color: row.color }}>{row.level}</span>
                <span className="docs-sevTable__weight">{row.weight}</span>
                <span className="docs-sevTable__pressure">{row.pressure}x</span>
                <span className="docs-sevTable__desc">{row.desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Scoring */}
        <section id="scoring" className="docs-section docs-fadein">
          <h2 className="docs-section__title">Security Score Calculation</h2>
          <p className="docs-section__intro">
            Signal produces a security score from <strong>0 to 50</strong>, where 0 means no findings and 50 means critical risk.
            The score uses a saturating exponential model so that even a few critical findings push the score up rapidly.
          </p>

          <div className="docs-card docs-formula">
            <div className="docs-card__label">Scoring Formula</div>
            <div className="docs-formula__steps">
              <div className="docs-formula__step">
                <span className="docs-formula__label">1. Weighted Total</span>
                <code className="docs-formula__code">rawScore = sum of each finding&apos;s weight</code>
              </div>
              <div className="docs-formula__step">
                <span className="docs-formula__label">2. Severity Pressure</span>
                <code className="docs-formula__code">pressure = critical×4.0 + high×2.0 + medium×0.5 + low×0.1</code>
              </div>
              <div className="docs-formula__step">
                <span className="docs-formula__label">3. Risk Index</span>
                <code className="docs-formula__code">riskIndex = rawScore + pressure × 8</code>
              </div>
              <div className="docs-formula__step">
                <span className="docs-formula__label">4. Final Score</span>
                <code className="docs-formula__code">score = 50 × (1 − e^(−riskIndex / 80))</code>
              </div>
            </div>
          </div>

          <div className="docs-scoreGuide">
            <div className="docs-scoreGuide__item docs-scoreGuide__item--strong">
              <span className="docs-scoreGuide__range">0 – 10</span>
              <span className="docs-scoreGuide__label">Strong</span>
              <span className="docs-scoreGuide__desc">Minimal or no findings. Your codebase is in great shape.</span>
            </div>
            <div className="docs-scoreGuide__item docs-scoreGuide__item--warn">
              <span className="docs-scoreGuide__range">11 – 25</span>
              <span className="docs-scoreGuide__label">Moderate</span>
              <span className="docs-scoreGuide__desc">Some findings detected. Review and address high-severity items.</span>
            </div>
            <div className="docs-scoreGuide__item docs-scoreGuide__item--critical">
              <span className="docs-scoreGuide__range">26 – 50</span>
              <span className="docs-scoreGuide__label">At Risk</span>
              <span className="docs-scoreGuide__desc">Significant vulnerabilities present. Immediate action recommended.</span>
            </div>
          </div>
        </section>

        {/* False positives */}
        <section id="false-positives" className="docs-section docs-fadein">
          <h2 className="docs-section__title">False Positive Prevention</h2>
          <p className="docs-section__intro">
            Signal is tuned to minimize noise. The following patterns are <strong>automatically excluded</strong> from results:
          </p>
          <div className="docs-card">
            <ul className="docs-fpList">
              {fpRules.map((rule) => (
                <li key={rule} className="docs-fpList__item">
                  <span className="docs-fpList__icon" aria-hidden>✓</span>
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Supported languages */}
        <section id="supported-languages" className="docs-section docs-fadein">
          <h2 className="docs-section__title">Supported Languages</h2>
          <p className="docs-section__intro">
            Signal analyzes source files across a wide range of languages and frameworks.
          </p>
          <div className="docs-langGrid">
            {[
              "JavaScript", "TypeScript", "JSX / TSX", "Python", "Java", "Go",
              "Ruby", "PHP", "Rust", "C#", "Swift", "Kotlin",
              "SQL", "YAML", "Shell / Bash",
            ].map((lang) => (
              <div key={lang} className="docs-langChip">{lang}</div>
            ))}
          </div>
        </section>

        {/* Resolution */}
        <section id="resolution" className="docs-section docs-fadein">
          <h2 className="docs-section__title">Automated Resolution</h2>
          <p className="docs-section__intro">
            Signal doesn&apos;t just find vulnerabilities — it can fix them. When you click &quot;Resolve&quot;, our AI resolution agent:
          </p>
          <div className="docs-resSteps">
            <div className="docs-resStep">
              <div className="docs-resStep__num">1</div>
              <p>Forks your repository and creates a dedicated fix branch.</p>
            </div>
            <div className="docs-resStep">
              <div className="docs-resStep__num">2</div>
              <p>Applies category-specific fix strategies — parameterized queries for SQL injection, output encoding for XSS, secret rotation patterns, and more.</p>
            </div>
            <div className="docs-resStep">
              <div className="docs-resStep__num">3</div>
              <p>Preserves your code style, function signatures, and module patterns. No new dependencies are added.</p>
            </div>
            <div className="docs-resStep">
              <div className="docs-resStep__num">4</div>
              <p>Opens a pull request with all fixes for your review. You stay in full control.</p>
            </div>
          </div>
        </section>

        <footer className="docs-footer">
          <p>Signal — Frontend Security Platform</p>
        </footer>
      </div>
    </main>
  );
}
