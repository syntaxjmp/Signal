import type { CSSProperties } from "react";
import React from "react";
import Image from "next/image";
import Link from "next/link";

export default function Home() {
  const bars = [
    0.18, 0.22, 0.28, 0.35, 0.46, 0.58, 0.46, 0.35, 0.28, 0.22, 0.31, 0.44,
    0.58, 0.46, 0.35, 0.28, 0.18, 0.12,
  ];

  return (
    <main className="landing">
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
          <a className="social-box" href="#" aria-label="X">
            X
          </a>
          <a className="social-box" href="#" aria-label="LinkedIn">
            in
          </a>
        </nav>
      </header>

      <section className="hero">
        <h1>
          Futureproof Your
          <br />
          Frontend
        </h1>
        <p>
          Signal enables developers to ship quickly and securely by detecting critical vulnerabilities
          instantly, all in a single click.
        </p>
        <div className="hero-actions">
          <a className="action action-primary" href="#">
            Stay up to Speed
          </a>
          <a className="action action-secondary" href="#">
            Read Documentation
          </a>
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
    </main>
  );
}
