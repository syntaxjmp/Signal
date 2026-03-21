# Project skills (LLM memory)

> **Signal:** This file helps your AI assistant avoid repeating issues and follow patterns in _this_ workspace.  
> The **Scan-derived rules** block is **replaced** after each Signal workspace scan with concise rules inferred from findings. Copy anything you want to keep permanently into the sections below.

---

## Common Mistakes

| Bad | Good | Rule |
|-----|------|------|
| `context.subscriptions.push(d)` after a path that can `return` early | Register every disposable before early returns, or use `try/finally` | Nothing that needs `dispose()` is skipped when activation aborts. |
| `vscode.workspace.rootPath` | `vscode.workspace.workspaceFolders?.[0]?.uri` | Multi-root workspaces; `rootPath` is deprecated. |
| Fire-and-forget `showInformationMessage` without handling rejection | `void vscode.window.showInformationMessage(...)` or `await` inside `async` | Unhandled promise rejections stay visible in devtools. |
| Concat paths with `a + "/" + b` for workspace files | `vscode.Uri.joinPath(folder, ...segments)` | Correct on Windows and with remote/SSH workspaces. |
| Hard-coded API URL in source | `vscode.workspace.getConfiguration("signal").get("apiBaseUrl")` + env docs in README | One place to change deploy targets. |

```ts
// Prefer: resolve paths from a workspace folder URI
const fileUri = vscode.Uri.joinPath(workspaceFolder, "src", "file.ts");
```

---

## Preferred Patterns

- **Activation:** Keep `activate()` thin — delegate to `registerCommands(context)`, `registerTreeViews(context)`, etc., each returning or pushing disposables.
- **Config:** Read once per action via `getConfiguration("signal")`; defaults belong in `package.json` `contributes.configuration`, not duplicated in code.
- **Logging:** One `OutputChannel` (e.g. `"Signal"`); gate verbose logs behind a setting like `signal.trace`.
- **Async:** Prefer `async`/`await`; wrap user-facing failures in short, actionable `showErrorMessage` strings.
- **Commands:** `registerCommand` callbacks should validate arguments (treat inputs as untrusted).
- **Tests:** Use `@vscode/test-electron` for integration tests; keep pure helpers in modules without `vscode` imports for easy unit tests.

---

## Architecture Rules

- **Entry:** `main` points to compiled JS under `out/`; do not add a second entry without updating `package.json` and build config.
- **Bundling:** Respect existing `tsconfig` / bundler; ship `out/**/*.js` + `resources/**` + `media/**` as packaged by the extension.
- **Webviews:** Single `nonce` + strict CSP; never inject unsanitized workspace or network HTML.
- **State:** Version keys in `workspaceState` / `globalState` (e.g. `signal.v1.cache`).
- **Dependencies:** Runtime deps in `dependencies`; types only in `devDependencies`.

---

## Security Rules

- **Secrets:** Use `ExtensionContext.secrets` for tokens — never commit real keys or `.env` with production values.
- **Network:** Honor `signal.apiBaseUrl` and optional Bearer token; validate URLs before requests; use HTTPS in production docs.
- **Findings / scans:** Treat file paths from API as hints only — resolve under workspace with `Uri.joinPath` before opening files.
- **Dependencies:** Run `npm audit` before release; prefer locked or pinned versions for reproducible builds.

---

## Gotchas / Edge Cases

- **Remote / SSH / WSL:** Files may live on the remote — use `vscode.workspace.fs` for workspace resources, not Node `fs` on the local disk unless intentional.
- **Activation:** Avoid `*` activation for everything — prefer `onCommand:`, `onLanguage:`, or `workspaceContains:` to keep startup light.
- **Windows:** Paths in `Uri.fsPath` use backslashes; compare with `Uri` equality or normalized paths, not raw string `===` across platforms.
- **Large workspaces:** Respect `signal.maxFiles` / `signal.maxFileBytes` when indexing — same limits as the scanner.

---

<!-- signal:auto-generated:start -->

## Scan-derived rules (Signal)

_Not run yet — perform **Signal: Scan workspace** or enable `signal.autoUpdateSkillsOnScan`._

<!-- signal:auto-generated:end -->

---

## Auto-update notes (for tooling)

- **Manual:** Use command **Signal: Open project skills** to create or edit this file.
- **Automatic:** After each workspace scan, the block between `<!-- signal:auto-generated:start -->` and `<!-- signal:auto-generated:end -->` is rewritten from current findings (high-signal summaries, not raw logs).

---

## Archived

<!-- Move superseded rules here with a date. -->
