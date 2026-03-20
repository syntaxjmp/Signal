# Signal — VS Code extension (MVP skeleton)

Hackathon MVP: index the open workspace, optionally POST to your Signal API, and show findings in the **Explorer → Signal Findings** tree. Selection scan and resolve actions are wired as commands for the next iteration.

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

**Response** (200):

```json
{
  "findings": [
    {
      "id": "uuid",
      "severity": "critical",
      "category": "SQL injection",
      "description": "...",
      "filePath": "src/db.ts",
      "lineNumber": 42,
      "snippet": "optional"
    }
  ]
}
```

`severity` must be one of: `critical`, `high`, `medium`, `low`, `info` (matches DB enum).

## Commands

- **Signal: Scan workspace** — re-run index + API call  
- **Signal: Scan selection** — context menu / palette when text is selected  
- **Signal: Resolve finding** — right-click a finding (placeholder until project/finding IDs exist)

## Repo layout note

- **This folder as workspace:** use **Run Extension** in `.vscode/launch.json` here.
- **Monorepo root (`Signal`) as workspace:** use **Signal extension (monorepo)** from the repo root `.vscode/launch.json` (runs `compile` in `Signal Extension VSC` first).
