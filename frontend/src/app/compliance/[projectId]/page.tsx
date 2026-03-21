"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export default function ComplianceReportPlaceholderPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #130704 0%, #1a0703 52%, #100402 100%)",
        color: "#f8f0ed",
        padding: "2.5rem 1.5rem",
      }}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: "0.75rem" }}>Compliance report</h1>
        <p style={{ color: "rgba(255, 220, 210, 0.85)", lineHeight: 1.6, marginBottom: "1.25rem" }}>
          Report generation for this project isn&apos;t wired up yet. You&apos;ll be able to create an audit-ready
          compliance document from here soon.
        </p>
        <p style={{ fontSize: "0.9rem", color: "rgba(255, 220, 210, 0.55)", marginBottom: "1.5rem" }}>
          Project ID: <code style={{ color: "rgba(255, 220, 210, 0.85)" }}>{projectId}</code>
        </p>
        <Link
          href="/dashboard"
          style={{
            display: "inline-block",
            padding: "0.55rem 1rem",
            borderRadius: 10,
            border: "1px solid rgba(255, 90, 52, 0.35)",
            color: "#fef8f6",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
