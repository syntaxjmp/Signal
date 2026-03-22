# Signal

Signal is an AI-powered security scanning platform designed to detect vulnerabilities, leaked secrets, injection-style bugs, and misconfigurations across GitHub repositories. The platform leverages large language models to perform intelligent code analysis, generate automated fix suggestions, and open pull requests with remediation patches — reducing the time between vulnerability discovery and resolution.

Signal also includes a Visual Studio Code extension that provides real-time security scanning directly within the editor, enabling developers to identify and address issues as they write code.

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Environment Configuration](#environment-configuration)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [VS Code Extension](#vs-code-extension)
- [Tech Stack](#tech-stack)
- [Future Vision](#future-vision)
- [Learn More](#learn-more)
- [License](#license)

---

## Features

- **Automated Vulnerability Scanning** — Scans GitHub repositories against 35 vulnerability categories mapped to CWE and OWASP standards.
- **AI-Powered Fix Generation** — Generates remediation patches using OpenAI and opens pull requests with the proposed fixes automatically.
- **Stateful Security Intelligence** — Maintains persistent memory of dismissed findings, regression detection, baseline anomaly analysis, and accepted risk validation across scans.
- **Compliance Reporting** — Scores repositories against SOC 2, OWASP Top 10, and GDPR compliance frameworks with exportable PDF reports.
- **Attack Chain Detection** — Identifies compound vulnerability chains where multiple findings combine to create elevated risk (e.g., unauthenticated endpoints with SQL injection).
- **Developer Risk Profiling** — Tracks per-author security metrics including findings introduced and average fix time.
- **Vector Similarity Search** — Uses Qdrant vector database to find semantically similar findings, fixes, and code patterns across the project history.
- **VS Code Extension** — Real-time code scanning, workspace analysis, and AI-powered finding explanations within the editor.
- **Webhook Notifications** — Discord webhook integration for scan results and SLA violation alerts.

---

## Architecture Overview

Signal is a full-stack monorepo application consisting of a Next.js frontend, an Express.js backend API, a MySQL database, and an optional Qdrant vector database for semantic search capabilities.

```
Browser / VS Code Extension
        |
   Next.js Frontend (port 3000)
        |
   /api/* proxy (Next.js rewrites)
        |
   Express.js Backend (port 4000)
        |
   +-----------+-----------+
   |           |           |
 MySQL 8    OpenAI API   Qdrant
                          (optional)
```

The frontend proxies all `/api/*` requests to the backend through Next.js rewrites configured in `next.config.mjs`. The backend handles authentication, scanning orchestration, AI analysis, and GitHub integration.

---

## Repository Structure

```
Signal/
  backend/                  Express.js API (ES modules, Node 20+, JavaScript)
    src/
      routes/               API route handlers
      services/             Scanning pipeline, resolution agent, stateful intelligence
      ai/                   Prompt templates for vulnerability analysis and fix generation
      config/               Environment validation and database configuration
  frontend/                 Next.js 16 (React 19, TypeScript, Tailwind CSS 4, App Router)
    src/
      app/                  App Router pages (dashboard, findings, compliance, docs)
      components/           React components including memory visualization panels
      lib/                  Auth client and shared utilities
  db/                       MySQL 8 schema and seed data
  Signal Extension VSC/     VS Code extension for real-time code scanning (TypeScript)
  qdrant-x86_64-pc-windows-msvc/   Local Qdrant vector database binary
  scripts/                  Database utility scripts
  docs/                     GitHub API workflow and engineering documentation
  slideDeck/                Pitch deck assets
```

---

## Prerequisites

- **Node.js** 20 or higher
- **MySQL** 8.x
- **Qdrant** (optional, required only for vector similarity features)
- A **GitHub Personal Access Token** with `repo` scope
- An **OpenAI API key**

---

## Environment Configuration

**This repository does not include a `.env` file.** You must create one manually in the `backend/` directory before running the application.

Create the file at:

```
backend/.env
```

The following environment variables must be configured:

### Required

| Variable | Description |
|---|---|
| `PORT` | HTTP port for the backend server (default: `4000`) |
| `MYSQL_HOST` | MySQL server hostname |
| `MYSQL_PORT` | MySQL server port (default: `3306`) |
| `MYSQL_USER` | MySQL username |
| `MYSQL_PASSWORD` | MySQL password |
| `MYSQL_DATABASE` | MySQL database name |
| `OPENAI_API_KEY` | OpenAI API key for vulnerability analysis and fix generation |
| `BETTER_AUTH_SECRET` | Authentication secret, minimum 32 characters. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Public base URL of the API (e.g., `http://localhost:3000`) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated list of trusted browser origins |
| `GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope |

### Optional

| Variable | Description |
|---|---|
| `NODE_ENV` | Environment mode (`development` or `production`) |
| `OPENAI_MODEL` | OpenAI model to use (default: `gpt-4o-mini`) |
| `DB_AUTO_MIGRATE` | Set to `1` in development only to auto-apply schema on startup |
| `CORS_ORIGINS` | Comma-separated allowed origins for CORS in production |
| `SCAN_CONCURRENCY` | Number of concurrent file analyses (default: `10`) |
| `SCAN_MAX_FILES` | Maximum files to scan per repository (default: `100`) |
| `QDRANT_URL` | Qdrant server URL (default: `http://localhost:6333`) |
| `QDRANT_API_KEY` | Qdrant API key, if authentication is enabled |
| `QDRANT_FINDING_COLLECTION` | Qdrant collection name for finding embeddings |
| `QDRANT_FIX_COLLECTION` | Qdrant collection name for fix embeddings |
| `QDRANT_CODE_PATTERN_COLLECTION` | Qdrant collection name for code pattern embeddings |
| `SLA_INTERVAL_MS` | SLA check interval in milliseconds (default: `3600000`) |

Example:

```env
NODE_ENV=development
PORT=4000

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=signal
MYSQL_PASSWORD=your_password_here
MYSQL_DATABASE=Signal

OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o-mini

BETTER_AUTH_SECRET=your-secret-min-32-chars-here
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000

GITHUB_TOKEN=ghp_your_token_here

QDRANT_URL=http://localhost:6333
```

---

## Getting Started

### 1. Set Up the Database

Create a MySQL database and user:

```sql
CREATE DATABASE Signal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'signal'@'%' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON Signal.* TO 'signal'@'%';
FLUSH PRIVILEGES;
```

### 2. Configure Environment Variables

Create the `backend/.env` file as described in the [Environment Configuration](#environment-configuration) section above.

### 3. Install Dependencies and Migrate

```bash
# Backend
cd backend
npm install
npm run db:migrate
npm run auth:migrate

# Frontend
cd ../frontend
npm install
```

### 4. Start the Application

Start the backend first, then the frontend:

```bash
# Terminal 1 — Backend (port 4000)
cd backend
npm run dev

# Terminal 2 — Frontend (port 3000)
cd frontend
npm run dev
```

### 5. Start Qdrant (Optional)

If you require vector similarity search features, start the local Qdrant instance:

```bash
cd qdrant-x86_64-pc-windows-msvc
./qdrant
```

The application will be accessible at `http://localhost:3000`.

---

## Usage

1. **Sign up** at `/signup` and log in at `/login`.
2. **Add a project** from the dashboard by providing a GitHub repository URL.
3. **Trigger a scan** to analyze the repository for vulnerabilities.
4. **Review findings** in the findings report page, filtered by severity, category, and status.
5. **Generate fixes** — select findings and let the AI resolution agent create a pull request with patches.
6. **Run compliance checks** to score the repository against SOC 2, OWASP, or GDPR frameworks and export PDF reports.

---

## VS Code Extension

The Signal VS Code extension provides real-time security scanning within the editor.

### Commands

- **Signal: Scan Workspace** — Scan all files in the current workspace.
- **Signal: Scan Selection** — Scan the currently selected code.
- **Signal: Explain Finding** — Get an AI-generated explanation of a specific finding.
- **Signal: Open Workspace Report** — View the full scan report.

### Configuration

| Setting | Description |
|---|---|
| `signal.apiBaseUrl` | Backend API URL (default: `http://localhost:4000`) |
| `signal.maxFiles` | Maximum files to scan per workspace |
| `signal.scanOnStartup` | Automatically scan workspace on extension activation |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Express.js, Node.js 20+, JavaScript (ES modules) |
| Database | MySQL 8 |
| Vector Store | Qdrant |
| Authentication | Better Auth 1.5.5 |
| AI | OpenAI API (GPT-4o-mini default) |
| 3D Visualization | Three.js, React Three Fiber |
| PDF Generation | PDFKit |
| VS Code Extension | TypeScript |

---

## Future Vision

Signal is designed to be an adaptive security platform that grows smarter with every scan, extends across organizations, and keeps teams in full control of their data. The following initiatives represent the platform's forward-looking roadmap.

### 01 — Portable Knowledge and MCP

Your findings, fixes, and developer profiles live in your own database — there is no vendor lock-in. Signal's architecture is designed so that teams can switch AI models at any time without losing accumulated intelligence. Through Model Context Protocol (MCP) integration, Signal will expose its security knowledge as a portable, interoperable layer that can be consumed by any compatible tool or agent.

### 02 — Adaptive Intelligence

Signal's memory is not static. Teams will be able to refine and adjust what Signal remembers — tuning dismissal policies, sharpening regression detection, and evolving baseline thresholds over time. The intelligence sharpens with every scan, not just accumulates. This creates a compounding feedback loop where each interaction makes the system more accurate and context-aware.

### 03 — Expanding Compliance Frameworks

Signal currently scores repositories against SOC 2, OWASP Top 10, and GDPR. The compliance engine is modular by design, making it straightforward to add new frameworks. On the roadmap: HIPAA, PCI-DSS, ISO 27001, NIST, and industry-specific standards such as FedRAMP and HITRUST. Support for custom internal policy frameworks is also planned, enabling organizations to codify and enforce their own security standards.

### 04 — Organization-Wide, Cross-Repository Intelligence

Through MCP server integration, Signal will enable cross-repository intelligence — a capability that is essential for microservice architectures where a vulnerability in one service can cascade across the entire stack. This includes shared vulnerability patterns across repositories, organization-wide compliance dashboards, and the ability to detect systemic security weaknesses that only become visible at the organizational level.

**The moat deepens over time:** every scan, dismissal, and fix makes Signal smarter — compounding value that becomes impossible to replicate.

```
Signal scans and learns --> Memory sharpens --> MCP connects everything --> Org-wide intelligence
```

---

## Learn More

For a comprehensive overview of Signal's capabilities, architecture, scanning pipeline, stateful intelligence system, and future roadmap, refer to the **Signal pitch deck** located at [`slideDeck/signal-pitch.html`](slideDeck/signal-pitch.html). Open the file in any browser to view the full interactive presentation.

---

## License

This project is proprietary. All rights reserved.
