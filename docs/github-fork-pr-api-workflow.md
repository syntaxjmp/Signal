# GitHub Fork & Pull Request via REST API

## What Happened

We forked `syntaxjmp/demovuln` and opened a PR with security fixes — entirely through the GitHub REST API using a PAT. No git clone, no `gh` CLI.

- **Fork**: `signal-agent-fix/demovuln`
- **Branch**: `fix-sql-injection`
- **PR**: https://github.com/syntaxjmp/demovuln/pull/1

---

## API Call Chain

Six sequential requests. Each depends on data from the previous one.

```
POST /repos/{owner}/{repo}/forks                   → 202  fork created (async)
GET  /repos/{fork}/git/ref/heads/main               → 200  get HEAD sha
POST /repos/{fork}/git/refs                          → 201  create branch from sha
GET  /repos/{fork}/contents/{file}?ref={branch}      → 200  get file sha
PUT  /repos/{fork}/contents/{file}                   → 200  commit updated file
POST /repos/{upstream}/pulls                         → 201  open cross-fork PR
```

---

## Detailed Breakdown

### 1. Fork the Repo

```http
POST https://api.github.com/repos/syntaxjmp/demovuln/forks

Authorization: Bearer <PAT>
Accept: application/vnd.github+json
```

Returns `202 Accepted`. The fork is created asynchronously — it may take a few seconds before it's fully accessible. If step 2 returns 404, wait and retry.

---

### 2. Get HEAD SHA

```http
GET https://api.github.com/repos/signal-agent-fix/demovuln/git/ref/heads/main
```

Response gives us the commit SHA to branch from:

```json
{ "object": { "sha": "62199ac..." } }
```

---

### 3. Create a Branch

```http
POST https://api.github.com/repos/signal-agent-fix/demovuln/git/refs

{
  "ref": "refs/heads/fix-sql-injection",
  "sha": "62199ac..."
}
```

---

### 4. Get the File SHA

```http
GET https://api.github.com/repos/signal-agent-fix/demovuln/contents/demovuln.py?ref=fix-sql-injection
```

Response includes `"sha": "be05d92..."` — required to update the file. You cannot PUT without it.

---

### 5. Commit the Fixed File

```http
PUT https://api.github.com/repos/signal-agent-fix/demovuln/contents/demovuln.py

{
  "message": "fix: patch SQL injection and other security vulnerabilities",
  "content": "<entire file, base64-encoded>",
  "sha": "be05d92...",
  "branch": "fix-sql-injection"
}
```

The `content` is the **full file** base64-encoded, not a diff. In Node.js:

```js
const encoded = Buffer.from(fileContent).toString('base64');
```

---

### 6. Open the Pull Request

```http
POST https://api.github.com/repos/syntaxjmp/demovuln/pulls

{
  "title": "fix: patch critical security vulnerabilities in demovuln.py",
  "head": "signal-agent-fix:fix-sql-injection",
  "base": "main",
  "body": "## Summary\n- Fixed SQL injection via parameterized queries\n..."
}
```

The `head` format for cross-fork PRs is `{fork_owner}:{branch}` — not just the branch name.

---

## Auth Requirements

| Field | Value |
|-------|-------|
| Token type | PAT (classic) |
| Stored in | `backend/.env` as `PAT` |
| Required scope | `repo` |
| Header format | `Authorization: Bearer <token>` |
| Also send | `Accept: application/vnd.github+json` |

---

## Why Our Signal API Can't Do This Yet

These are the gaps to investigate when wiring this into the Express backend:

### 1. No GitHub API integration exists

The backend (`backend/src/routes/`) has no route or service that calls `api.github.com`. We'd need a new service (e.g., `src/services/githubApi.js`) that wraps these six calls.

### 2. Async fork timing

Step 1 returns `202`, not `201`. The fork isn't immediately ready. Our API would need to poll or retry step 2 with a short backoff before continuing. Something like:

```js
// Pseudocode
await createFork(owner, repo);
let sha;
for (let i = 0; i < 5; i++) {
  try {
    sha = await getHeadSha(forkOwner, repo);
    break;
  } catch {
    await sleep(2000);
  }
}
```

### 3. Base64 encoding for file commits

The Contents API requires the full file base64-encoded. If we're generating fix content (e.g., from the resolution agent), we need to encode the output before sending:

```js
Buffer.from(fixedCode).toString('base64')
```

### 4. Cross-fork PR head format

The `head` must be `{fork_owner}:{branch}`. If we just send `"fix-sql-injection"` it will 422. This is an easy mistake.

### 5. File SHA is mandatory for updates

Every file update requires the current SHA. The flow is always GET then PUT. If another process modifies the file between those calls, we get a `409 Conflict`.

### 6. Token scope

The `PAT` in `.env` needs `repo` scope. If it only has `public_repo` or is a fine-grained token, some operations may 403.

---

## Error Reference

| Code | Meaning | Common Cause |
|------|---------|--------------|
| 202 | Accepted | Fork is being created (async, not an error) |
| 401 | Unauthorized | Token expired, revoked, or missing |
| 403 | Forbidden | Token lacks `repo` scope |
| 404 | Not found | Fork not ready yet, wrong owner/repo, or repo is private |
| 409 | Conflict | File SHA mismatch — file changed between GET and PUT |
| 422 | Validation failed | Bad `head` format, branch missing, or duplicate PR |

Rate limit: 5,000 requests/hour for authenticated calls. Check `X-RateLimit-Remaining` header.

---

## Security Fixes in the PR

| Vulnerability | What Was Wrong | What Was Fixed |
|---|---|---|
| SQL Injection | `f"SELECT * FROM users WHERE username = '{username}'"` | Parameterized queries with `?` placeholders |
| Hardcoded Secrets | `DB_PASSWORD = "SuperSecret123"` in source | `os.environ.get("DB_PASSWORD", "change-me")` |
| XSS | Raw `{msg}` in HTML response | `html.escape(msg)` |
| Command Injection | `os.popen(f"ping -c 1 {host}")` | `subprocess.run(["ping", "-c", "1", host])` + regex validation |
| Path Traversal | `open(f"./files/{filename}")` | `os.path.realpath()` + startswith check |
| Insecure Deserialization | `pickle.loads(data)` | `json.loads(data)` |
| Missing Auth on Mutation | No auth on `/change_password` | Requires `Authorization` header |
| Debug Mode | `app.run(debug=True)` | `app.run(debug=False)` |
