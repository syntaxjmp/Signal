# Signal — VS Code extension (MVP skeleton)

Workspace scans open a **findings report** panel (aligned with the web report) titled with your **workspace folder name** (e.g. `folderA`), plus the **Signal Findings** tree. Use **Signal: Open workspace report** to reopen the last scan. Selection scans update the tree only.

## Run locally

1. Open this folder (`Signal Extension VSC`) as the VS Code workspace root (so `extensionDevelopmentPath` resolves correctly).
2. `npm install`
3. **Run → Start Debugging** (F5) — a new Extension Development Host window opens.

On startup (default), the extension indexes source files (same extensions as `backend/src/services/projectScanner.js`) and POSTs to the API at **`http://localhost:4000`** by default (Signal backend’s default `PORT`).

## Settings (`signal.*`)

| Setting | Purpose |
|--------|---------|
| `signal.apiBaseUrl` | **Default:** `http://localhost:4000`. Override for staging/prod; clear for index-only (no HTTP). |
| `signal.apiToken` | Optional `Authorization: Bearer …` |
| `signal.workspaceScanPath` | POST path (default `/api/extension/workspace-scan`) |
| `signal.snippetScanPath` | POST path (default `/api/extension/snippet-scan`) |
| `signal.scanOnStartup` | Run workspace scan after VS Code startup |
| `signal.skillsFile` | Workspace-relative path for **LLM memory** (default `skills.md`). |
| `signal.autoUpdateSkillsOnScan` | After each workspace scan, rewrite the auto-generated block in `skills.md` with concise rules derived from findings (for Cursor / Copilot / etc.). |

## Project skills (`skills.md`)

The extension ships a Markdown template (`resources/skills.template.md`) with sections for **Common Mistakes**, **Preferred Patterns**, **Architecture / Security**, **Gotchas**, plus a **Scan-derived rules** block delimited by HTML comments.

- **Signal: Open project skills** — creates `skills.md` from the template if missing, then opens it.
- **Signal: Update skills.md from last scan** — refreshes the scan-derived block from the most recent workspace scan (same merge logic as auto-update).

When **`signal.autoUpdateSkillsOnScan`** is enabled (default), each **Scan workspace** run replaces the `<!-- signal:auto-generated:start -->` … `<!-- signal:auto-generated:end -->` region with grouped, LLM-friendly bullets inferred from current findings (not raw logs). Copy rules you want to keep forever into the manual sections above the markers.

## API (backend)

Routes live on the Signal API under **`/api/extension`** (`snippet-scan`, `workspace-scan`). Both accept `POST` with `Content-Type: application/json`. Requires **`OPENAI_API_KEY`** on the server.

**Workspace** body:

```json
{
  "source": "vscode-extension",
  "files": [{ "path": "src/app.ts", "content": "..." }]
}
```

**Snippet** body:

```json
{
  "source": "vscode-extension",
  "code": "...",
  "languageId": "typescript",
  "filePath": "src/app.ts"
}
```

**Workspace response** (200) includes a **`summary`** (security score 0–50, severity counts, scanned file count) and optional **`weightedScore`** on each finding.

```json
{
  "summary": {
    "scannedFilesCount": 12,
    "totalFindings": 3,
    "securityScore": 18,
    "severityCounts": { "critical": 0, "high": 1, "medium": 2, "low": 0 },
    "totalWeightedScore": 22
  },
  "findings": [
    {
      "id": "uuid",
      "severity": "critical",
      "category": "SQL injection",
      "description": "...",
      "filePath": "src/db.ts",
      "lineNumber": 42,
      "snippet": "optional",
      "weightedScore": 10
    }
  ]
}
```

Snippet scans return `{ "findings": [ ... ] }` only (no `summary`).

`severity` must be one of: `critical`, `high`, `medium`, `low`, `info` (matches DB enum).

## Commands

- **Signal: Scan workspace** — index + API call, opens the workspace report panel  
- **Signal: Open workspace report** — reopen the last workspace scan report  
- **Signal: Explain finding** — natural-language breakdown (junior dev friendly). Right‑click a finding in the tree, or use the Explain button in the report  
- **Signal: Scan selection** — context menu / palette when text is selected  
- **Signal: Resolve finding** — right-click a finding (placeholder until project/finding IDs exist)
- **Signal: Open project skills** — open or create workspace `skills.md` (LLM memory)
- **Signal: Update skills.md from last scan** — merge last scan into the auto-generated block

## Repo layout note

- **This folder as workspace:** use **Run Extension** in `.vscode/launch.json` here.
- **Monorepo root (`Signal`) as workspace:** use **Signal extension (monorepo)** from the repo root `.vscode/launch.json` (runs `compile` in `Signal Extension VSC` first).
