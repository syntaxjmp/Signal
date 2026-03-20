# AI Tool System Architecture — Planning Doc

## Overview

This document covers **what tools to expose to the AI agent**, **how to make it autonomously search and analyze code**, and **whether to use LangChain/LangGraph vs. building a custom tool-calling system**.

---

## 1. Tools We Should Expose to the AI

The AI agent needs to go from "user connects a repo" to "here are your security vulnerabilities" **autonomously**. That means it needs tools — functions it can decide to call on its own.

### Core Tool Set

| Tool | What It Does | Why the AI Needs It |
|------|-------------|---------------------|
| `list_repo_tree` | Calls GitHub Trees API to get every file path in the repo | The AI needs to **see** the full repo structure before deciding what to scan |
| `read_file` | Fetches a single file's content via GitHub Blobs API | The AI reads files one at a time to analyze them |
| `search_code` | Calls GitHub Code Search API (`GET /search/code?q=...`) | Lets the AI grep across the repo for patterns like `eval(`, `exec(`, hardcoded secrets |
| `list_commits` | Fetches recent commits via GitHub Commits API | The AI can check what changed recently — new code is higher risk |
| `get_diff` | Fetches the diff between two refs via GitHub Compare API | Lets the AI focus on **changed** code instead of re-scanning everything |
| `read_package_manifest` | Reads `package.json`, `requirements.txt`, `go.mod`, etc. | Dependency scanning — check for known vulnerable packages |
| `report_vulnerability` | Writes a structured finding (file, line, severity, description) | The AI's output mechanism — it calls this tool to log each finding |

### Optional / Advanced Tools

| Tool | What It Does | When to Add |
|------|-------------|-------------|
| `check_npm_audit` / `check_pip_audit` | Runs known-vulnerability databases against dependencies | Phase 2 — after core scanning works |
| `read_github_actions` | Reads `.github/workflows/*.yml` | CI/CD misconfiguration scanning |
| `check_branch_protection` | Reads repo settings via GitHub API | Repo security posture checks |
| `search_secrets` | Regex scan for API keys, tokens, passwords | Could be a dedicated tool or part of the AI's prompt |

### How Each Tool Should Be Defined

Every tool is just a **function with a name, description, and parameters** that the AI can call:

```javascript
// Example tool definition
const tools = [
  {
    name: "list_repo_tree",
    description: "Lists all files and directories in the repository. Call this first to understand the repo structure before reading individual files.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub repo owner" },
        repo: { type: "string", description: "GitHub repo name" },
        branch: { type: "string", description: "Branch to scan", default: "main" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "read_file",
    description: "Reads the content of a single file from the repository. Use this after list_repo_tree to read files that look security-relevant.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        file_path: { type: "string", description: "Path to the file, e.g. src/auth/login.js" }
      },
      required: ["owner", "repo", "file_path"]
    }
  },
  {
    name: "report_vulnerability",
    description: "Report a security vulnerability found in the code. Call this every time you identify a security issue.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        line_number: { type: "number" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
        vulnerability_type: { type: "string", description: "e.g. SQL Injection, XSS, Hardcoded Secret" },
        description: { type: "string" },
        recommendation: { type: "string" }
      },
      required: ["file_path", "severity", "vulnerability_type", "description"]
    }
  }
];
```

---

## 2. How to Make the AI Actually Search on Its Own

The key insight: **the AI doesn't just answer a question — it runs a loop where it picks tools, calls them, reads results, and decides what to do next.** This is called an "agentic loop."

### The Agentic Loop

```
┌─────────────────────────────────────┐
│  System Prompt:                     │
│  "You are a security scanner.       │
│   Use your tools to scan the repo.  │
│   Report every vulnerability."      │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  AI decides: "First, let me get  │
│  the file tree."                 │
│  → calls list_repo_tree          │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Tool executes, returns file     │
│  list back to AI                 │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  AI decides: "I see auth.js,     │
│  db.js, .env — let me read       │
│  those first."                   │
│  → calls read_file (auth.js)     │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  AI analyzes code, finds SQLi    │
│  → calls report_vulnerability    │
│  → calls read_file (db.js)       │
│  ...keeps going until done...    │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  AI: "I've scanned all relevant  │
│  files. Here's my summary."      │
│  → DONE                          │
└──────────────────────────────────┘
```

### The System Prompt Is Critical

The system prompt tells the AI **how** to scan. This is where your scanning strategy lives:

```
You are a security vulnerability scanner. You have access to tools for reading
a GitHub repository. Your job is to systematically scan the codebase and report
every security vulnerability you find.

## Your Process
1. First, call list_repo_tree to get the full file structure.
2. Identify high-priority files: authentication, database queries, API routes,
   environment/config files, dependency manifests.
3. Read each high-priority file with read_file.
4. For each vulnerability found, call report_vulnerability with full details.
5. After high-priority files, scan remaining source code files.
6. Skip binary files, images, lock files, and node_modules.

## What to Look For
- SQL injection (string concatenation in queries)
- XSS (unsanitized user input rendered in HTML)
- Hardcoded secrets (API keys, passwords, tokens in source code)
- Insecure authentication (weak hashing, no rate limiting)
- Path traversal (user input in file paths)
- Command injection (user input in exec/spawn calls)
- Insecure dependencies (known vulnerable package versions)
- Missing CSRF protection
- Overly permissive CORS
- Sensitive data in logs
```

---

## 3. LangChain / LangGraph vs. Custom Tool-Calling System

This is the biggest architectural decision. Here's an honest breakdown.

### Option A: LangChain / LangGraph

**What it gives you:**
- Pre-built agentic loop (you don't write the tool-call → execute → feed-back-to-AI cycle)
- Tool definition abstractions (decorators/classes)
- Built-in memory and conversation management
- LangGraph adds stateful, multi-step workflows with branching logic
- Large ecosystem of pre-built integrations

**LangChain example:**
```python
from langchain_anthropic import ChatAnthropic
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.tools import tool

@tool
def list_repo_tree(owner: str, repo: str, branch: str = "main") -> str:
    """Lists all files in a GitHub repository."""
    # GitHub API call here
    ...

@tool
def read_file(owner: str, repo: str, file_path: str) -> str:
    """Reads a file from the repository."""
    # GitHub API call here
    ...

@tool
def report_vulnerability(file_path: str, severity: str, vulnerability_type: str, description: str) -> str:
    """Reports a security vulnerability found during scanning."""
    # Store the finding
    ...

llm = ChatAnthropic(model="claude-sonnet-4-6")
tools = [list_repo_tree, read_file, report_vulnerability]
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)

result = executor.invoke({"input": "Scan the repo octocat/hello-world for security vulnerabilities"})
```

**LangGraph example (more control over flow):**
```python
from langgraph.graph import StateGraph, END

# Define a state machine:
# START → scan_tree → prioritize_files → scan_files → summarize → END
# With loops: scan_files can cycle back to itself until all files are scanned

graph = StateGraph(ScannerState)
graph.add_node("scan_tree", scan_tree_node)
graph.add_node("prioritize", prioritize_node)
graph.add_node("scan_file", scan_file_node)
graph.add_node("summarize", summarize_node)

graph.add_edge("scan_tree", "prioritize")
graph.add_edge("prioritize", "scan_file")
graph.add_conditional_edges("scan_file", should_continue, {
    "continue": "scan_file",
    "done": "summarize"
})
graph.add_edge("summarize", END)
```

**Downsides of LangChain/LangGraph:**
- Heavy abstraction layer — when something breaks, debugging through their internals is painful
- Version churn — APIs change frequently, tutorials go stale
- Overkill for straightforward tool-calling (which is what we're doing)
- Adds a significant dependency; their abstractions can fight you when you need custom behavior
- Performance overhead — extra layers between you and the API

---

### Option B: Custom Tool-Calling System (Recommended)

**The core agentic loop is ~60 lines of code.** Claude (and other LLMs) natively support tool calling — you don't need a framework to use it.

**Here's the full custom implementation:**

```javascript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// --- Define your tools as plain objects ---
const toolDefinitions = [
  {
    name: "list_repo_tree",
    description: "Lists all files in a GitHub repo. Call this first.",
    input_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string", default: "main" }
      },
      required: ["owner", "repo"]
    }
  },
  {
    name: "read_file",
    description: "Reads a file from the repo.",
    input_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        file_path: { type: "string" }
      },
      required: ["owner", "repo", "file_path"]
    }
  },
  {
    name: "report_vulnerability",
    description: "Report a security vulnerability.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
        vulnerability_type: { type: "string" },
        description: { type: "string" },
        recommendation: { type: "string" }
      },
      required: ["file_path", "severity", "vulnerability_type", "description"]
    }
  }
];

// --- Map tool names to actual functions ---
const toolHandlers = {
  list_repo_tree: async ({ owner, repo, branch }) => { /* GitHub API call */ },
  read_file: async ({ owner, repo, file_path }) => { /* GitHub API call */ },
  report_vulnerability: async (params) => { /* Store finding, return confirmation */ },
};

// --- The agentic loop (this is the whole thing) ---
async function runSecurityScan(owner, repo) {
  const messages = [
    {
      role: "user",
      content: `Scan the repository ${owner}/${repo} for security vulnerabilities. Use your tools to read the codebase and report every issue you find.`
    }
  ];

  const findings = [];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,  // The scanning instructions from Section 2
      tools: toolDefinitions,
      messages: messages,
    });

    // Add assistant's response to conversation history
    messages.push({ role: "assistant", content: response.content });

    // If the AI is done (no more tool calls), break
    if (response.stop_reason === "end_turn") {
      break;
    }

    // Process each tool call
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`AI is calling: ${block.name}(${JSON.stringify(block.input)})`);

        const handler = toolHandlers[block.name];
        const result = await handler(block.input);

        // Collect vulnerability reports
        if (block.name === "report_vulnerability") {
          findings.push(block.input);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }

    // Feed tool results back to the AI so it can continue
    messages.push({ role: "user", content: toolResults });
  }

  return findings;
}
```

**That's the entire framework.** No dependencies beyond the Anthropic SDK.

**Why this is better for our use case:**
- **Full control** — you see exactly what's happening, no black-box abstractions
- **Easy to debug** — log every tool call and response, step through the loop
- **No dependency risk** — LangChain's frequent breaking changes won't affect you
- **Easy to extend** — adding a new tool = add an object + a handler function
- **Lighter** — fewer dependencies, faster startup, smaller bundle
- **You actually understand it** — critical when things go wrong in production

---

### Option C: Hybrid (Recommended if workflows get complex later)

Start with **Option B (custom)** now. If the scanning workflow grows complex enough that you need:
- Multi-agent coordination (one agent scans frontend, another scans backend)
- Complex branching workflows with state persistence
- Human-in-the-loop approval steps

Then adopt **LangGraph specifically** (not LangChain) for the orchestration layer while keeping your custom tools.

---

## 4. Recommendation Summary

| Decision | Recommendation | Reasoning |
|----------|---------------|-----------|
| **Framework** | Custom tool-calling (Option B) | Our use case is a single-agent loop with tools — a framework adds complexity without proportional value |
| **Tool format** | Claude native tool calling | Direct API support, no translation layer needed |
| **When to adopt LangGraph** | If/when we need multi-agent or complex state machines | Don't add it preemptively |
| **Language** | JavaScript/TypeScript (matches existing stack) | We already have a Next.js frontend and Node backend |

## 5. Implementation Phases

### Phase 1 — MVP Scanner
- Implement the 3 core tools: `list_repo_tree`, `read_file`, `report_vulnerability`
- Write the agentic loop (~60 lines)
- Build the system prompt with scanning instructions
- Wire it to a simple API endpoint: `POST /api/scan { owner, repo }`
- Return findings as JSON

### Phase 2 — Smarter Scanning
- Add `search_code` tool for pattern-based searching
- Add `read_package_manifest` for dependency scanning
- Add file-type filtering (skip binaries, lock files, etc.)
- Add token/cost tracking (each scan costs API tokens)

### Phase 3 — Production Hardening
- Add webhook-based scanning (scan on every push)
- Add caching (don't re-scan unchanged files — use git SHAs)
- Add rate limiting for GitHub API calls
- Add scan history and diff-based scanning (only scan what changed)

### Phase 4 — Multi-Agent (if needed)
- Evaluate LangGraph for orchestrating specialized agents
- Consider separate agents for: frontend code, backend code, dependencies, infrastructure/CI
