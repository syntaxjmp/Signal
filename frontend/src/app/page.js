export default function Home() {
  const bars = [
    0.18, 0.22, 0.28, 0.35, 0.46, 0.58, 0.46, 0.35, 0.28, 0.22, 0.31, 0.44,
    0.58, 0.46, 0.35, 0.28, 0.18, 0.12,
  ];

  return (
    <main className="landing">
      <div className="vignette" aria-hidden="true" />

      <header className="top-nav">
        <a href="#" className="brand" aria-label="Signal home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Signal
        </a>

        <nav className="nav-links" aria-label="Primary">
          <a href="#">About Us</a>
          <a href="#">Blog</a>
          <a href="#">Resources</a>
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
          Signal makes product experiences feel instant and dependable,
          empowering high-growth teams to scale without complexity.
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
            style={{
              "--height": `${height}`,
              "--delay": `${index * 90}ms`,
            }}
          />
        ))}
      </section>
    </main>
  );
}
