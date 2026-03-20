# Signal

Lightweight security scanner: autonomous checks for leaked secrets, injection-style bugs, and common misconfigurations. This repo currently contains the **Express + MySQL** API foundation.

## Requirements

- Node.js 20+
- MySQL 8.x

## Quick start

1. Create database and user (example):

```sql
CREATE DATABASE signal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'signal'@'%' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON signal.* TO 'signal'@'%';
FLUSH PRIVILEGES;
```

2. Copy environment file and edit values:

```bash
cp .env.example .env
```

3. Install and migrate app schema + Better Auth tables:

```bash
npm install
npm run db:migrate
npm run auth:migrate
```

`auth:migrate` creates Better Auth tables (`user`, `session`, `account`, `verification`) in the same MySQL database as `MYSQL_DATABASE`.

4. Run API:

```bash
npm run dev
```

- `GET /api` — service metadata  
- `GET /api/health` — liveness  
- `GET /api/health/ready` — readiness (MySQL ping)  
- `GET /api/vulnerability-check-types` — catalog of implemented/planned check types  
- `ALL /api/auth/*` — [Better Auth](https://www.better-auth.com/) (sign-up, sign-in, session, etc.). Check `GET /api/auth/ok`.  
- `GET /api/me` — current session JSON (uses session cookie / headers from Better Auth)  

### Frontend (Next.js)

Use the Better Auth client with `baseURL` set to this API (e.g. `http://localhost:3000` if the API listens on 3000). Run the Next dev server on another port (e.g. `3001`) and list that origin in `BETTER_AUTH_TRUSTED_ORIGINS` / `CORS_ORIGINS`.

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `3000`) |
| `MYSQL_*` | Connection settings |
| `DB_AUTO_MIGRATE` | Set `1` in **development only** to apply `db/schema.sql` on startup (drops/recreates tables). Prefer `npm run db:migrate`. |
| `CORS_ORIGINS` | Comma-separated allowed origins in production |
| `BETTER_AUTH_SECRET` | **Required.** ≥32 chars; generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Public base URL of this API (no trailing slash), e.g. `http://localhost:3000` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated browser origins (e.g. Next app). If empty in dev, defaults include `http://localhost:3000` and `http://localhost:3001` |

## Database layout

- **`vulnerability_check_types`** — canonical slugs and metadata for every class of issue Signal can report (seeded in `db/schema.sql`).
- **`codebase_artifacts`** — uploaded archives / extraction output (for the future uploader + extractor pipeline).
- **`scans`** — one row per run: **`id`**, optional **`artifact_id`**, **`scanned_files`** (JSON array of relative paths scanned), **`files_scanned_count`**, **`started_at`** / **`finished_at`**, **`duration_ms`**, **`summary`** (JSON aggregates), **`status`**, **`error_message`**.
- **`findings`** — individual matches tied to a scan and check type (file, lines, severity, snippet, JSON metadata).

## Production notes

- Do not enable `DB_AUTO_MIGRATE` in production; use proper forward-only migrations when the schema stabilizes.
- Set `CORS_ORIGINS` when the API is called from a browser.
- Run behind HTTPS termination; keep `helmet` defaults and tune CSP when you add a frontend.
