/**
 * Space tools — the mini-computer workspace.
 *
 * Every space gets a REAL directory on this machine
 * (.data/space-workspaces/<spaceId>/). Mission agents act on it through a
 * small, journaled tool surface:
 *
 *   write_file / read_file / list_files / delete_file  — the workspace fs
 *   run_command   — allowlisted binaries, cwd = workspace, 20s timeout
 *   fetch_url     — GET, text-only, size/time capped (this is how a watcher
 *                   reads a YouTube channel feed)
 *   github_publish — commit+push files via the GitHub REST API (no git
 *                   binary needed); token from GITHUB_TOKEN or the request
 *
 * Everything is executed and recorded as it happened — no tool result is
 * ever invented. Commands are restricted to an allowlist because a local
 * app still shouldn't rm -rf the host it runs on.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_ROOT = path.resolve(
  /*turbopackIgnore: true*/ process.cwd(),
  ".data/space-workspaces",
);

/** Windows: npm/npx/py launchers are .cmd shims — spawn() needs a shell to
 *  execute them (raw spawn dies with ENOENT). posix: no shell, unchanged. */
const IS_WINDOWS = process.platform === "win32";

export function workspaceDir(spaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(spaceId)) throw new Error("bad space id");
  return path.join(WORKSPACE_ROOT, spaceId);
}

export async function ensureWorkspace(spaceId: string): Promise<string> {
  const dir = workspaceDir(spaceId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Confine a path inside the workspace (no ../ escapes, no absolute paths). */
function safePath(dir: string, p: string): string {
  if (path.isAbsolute(p)) throw new Error("path escapes workspace");
  const full = path.resolve(dir, p);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error("path escapes workspace");
  return full;
}

// ---------------- file tools ----------------

export async function toolWriteFile(dir: string, p: string, content: string): Promise<string> {
  const full = safePath(dir, p);
  const check = await syntaxCheck(p, content);
  if (check.checked && !check.ok) {
    return `error: ${p} has syntax errors — NOT written.\n${check.error}\nFix and retry.`;
  }
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return `wrote ${p} (${content.length} bytes)${check.checked ? " · syntax ✓" : ""}`;
}

/**
 * Windowed file viewer (SWE-agent ACI style): line-numbered, bounded view.
 * Default shows the first 100 lines; startLine/endLine select a window.
 * Compact feedback beats dumping whole files into context.
 */
export async function toolReadFile(
  dir: string,
  p: string,
  opts: { startLine?: number; endLine?: number } = {},
): Promise<string> {
  const full = safePath(dir, p);
  const content = await readFile(full, "utf8");
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.round(opts.startLine ?? 1));
  const end = Math.min(total, Math.round(opts.endLine ?? start + 99));
  if (start > total) return `(empty view: file has ${total} line(s))`;
  const view = lines
    .slice(start - 1, end)
    .map((l, i) => String(start + i).padStart(4) + "| " + l)
    .join("\n");
  const where = start > 1 || end < total ? ` (lines ${start}-${end} of ${total})` : ` (${total} line(s))`;
  const hint = end < total ? `\n(…${total - end} more lines — pass startLine to view them)` : "";
  return view.slice(0, 8000) + where + hint;
}

export async function toolListFiles(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else {
        const s = await stat(path.join(d, e.name));
        out.push(`${rel} (${s.size}B)`);
      }
    }
  };
  await walk(dir, "");
  return out.length ? out.join("\n") : "(workspace is empty)";
}

export async function toolDeleteFile(dir: string, p: string): Promise<string> {
  const full = safePath(dir, p);
  await rm(full, { force: true });
  return `deleted ${p}`;
}

// ---------------- command tool ----------------

const COMMAND_ALLOWLIST = ["node", "npm", "npx", "git", "python3", "ls", "cat"] as const;

/** Extra binaries a mission explicitly opted into (never a default). */
export function commandAllowed(cmd: string, extraAllow: string[] = []): boolean {
  const base = cmd.trim().split(/\s+/)[0];
  return (COMMAND_ALLOWLIST as readonly string[]).includes(base) || extraAllow.includes(base);
}

export async function toolRunCommand(
  dir: string,
  cmd: string,
  timeoutMs = 20_000,
  extraAllow: string[] = [],
  execTarget?: import("./workspace-isolation").ExecTarget,
): Promise<string> {
  if (!commandAllowed(cmd, extraAllow)) {
    return `refused: "${cmd.trim().split(/\s+/)[0]}" is not on the tool allowlist (${COMMAND_ALLOWLIST.join(", ")}${extraAllow.length ? " + " + extraAllow.join(", ") : ""})`;
  }
  // Phase B: when the mission runs isolated, commands execute INSIDE the
  // container (same allowlist, same timeout); file tools above keep using
  // the same directory from the host — it is bind-mounted, both views match.
  if (execTarget && execTarget.env === "isolated") {
    const { runInTarget } = await import("./workspace-isolation");
    return runInTarget(execTarget, cmd, timeoutMs);
  }
  return new Promise((resolve) => {
    const parts = cmd.trim().split(/\s+/);
    // Clean env: never leak the host process's test-runner context into
    // child processes (a nested `node --test` would otherwise no-op).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(parts[0], parts.slice(1), { cwd: dir, timeout: timeoutMs, env, shell: IS_WINDOWS });
    let out = "";
    const cap = (s: string) => {
      if (out.length < 8000) out += s;
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("error", (e) => resolve(`error: ${e.message}`));
    child.on("close", (code) => resolve(`exit ${code}\n${out.slice(0, 8000)}`));
  });
}

// ---------------- fetch tool ----------------

export async function toolFetchUrl(url: string, timeoutMs = 15_000): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `error: invalid URL`;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "error: only http(s) URLs";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "ArenaOS-Space/1.0 (local-first agent workspace)" },
    });
    const text = await res.text();
    return `status ${res.status} ${res.statusText}\n${text.slice(0, 200_000)}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "fetch failed"}`;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- syntax guardrail ----------------

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Post-edit guardrail (SWE-agent finding: rejecting edits that introduce
 * syntax errors prevents cascading failures — removing linting cost ~3
 * points on SWE-bench). JSON is parsed; JS/MJS/CJS are `node --check`ed.
 * Other file types are honestly reported as not checked.
 */
export async function syntaxCheck(
  p: string,
  content: string,
): Promise<{ ok: boolean; checked: boolean; error?: string }> {
  const lower = p.toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      JSON.parse(content);
      return { ok: true, checked: true };
    } catch (e) {
      return { ok: false, checked: true, error: e instanceof Error ? e.message : "invalid JSON" };
    }
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    let tmp = "";
    try {
      const dir = await mkdtemp(path.join(tmpdir(), "wy-check-"));
      tmp = path.join(dir, "check" + lower.slice(lower.lastIndexOf(".")));
      await writeFile(tmp, content, "utf8");
      const nodeBin = process.execPath;
      const checkArgs = ["--check", tmp];
      const res = spawnSync(nodeBin, checkArgs, { timeout: 15_000, encoding: "utf8" });
      if (res.status === 0) return { ok: true, checked: true };
      return { ok: false, checked: true, error: String(res.stderr || "syntax check failed").slice(0, 500) };
    } catch (e) {
      return { ok: true, checked: false, error: e instanceof Error ? e.message : undefined };
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
    }
  }
  return { ok: true, checked: false };
}

/** Show a numbered window of `content` centered on `anchor` (post-edit redisplay). */
function redisplay(content: string, anchor: string): string {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => anchor && l.includes(anchor.split("\n")[0]));
  const center = idx >= 0 ? idx : 0;
  const start = Math.max(0, center - 6);
  const end = Math.min(lines.length, center + 10);
  return lines
    .slice(start, end)
    .map((l, i) => String(start + i + 1).padStart(4) + "| " + l)
    .join("\n");
}

// ---------------- edit tool (SEARCH/REPLACE) ----------------

/**
 * Surgical editing (Aider's finding: for files over ~400 lines,
 * search/replace blocks use ~10x fewer tokens than whole-file rewrites).
 * Guards against the classic failure modes: unique-match enforcement
 * (duplicate matches refuse), whitespace drift tolerated, syntax-checked
 * after apply — broken edits are REVERTED and reported, never silently
 * half-applied.
 */
export async function toolEditFile(
  dir: string,
  args: { path: string; old_text: string; new_text: string },
): Promise<string> {
  const p = String(args.path ?? "");
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  if (!oldText) return "error: old_text is required (use read_file to view exact text first)";
  const full = safePath(dir, p);
  let original: string;
  try {
    original = await readFile(full, "utf8");
  } catch {
    return `error: ${p} does not exist — use write_file to create it`;
  }
  if (oldText === newText) return "error: old_text and new_text are identical";

  const countOccurrences = (hay: string, needle: string) =>
    hay.split(needle).length - 1;

  let occurrences = countOccurrences(original, oldText);
  let normalized = false;
  if (occurrences === 0 && original.includes("\r\n")) {
    // whitespace drift: CRLF source vs LF search text
    const flat = original.replace(/\r\n/g, "\n");
    occurrences = countOccurrences(flat, oldText.replace(/\r\n/g, "\n"));
    if (occurrences === 1) {
      original = flat;
      normalized = true;
    }
  }
  if (occurrences === 0) {
    return (
      `error: old_text not found in ${p} (edit NOT applied). ` +
      `Use read_file to view the exact current text — watch whitespace and quotes.`
    );
  }
  if (occurrences > 1) {
    return (
      `error: old_text matches ${occurrences} locations in ${p} (edit NOT applied). ` +
      `Include more surrounding lines so the match is unique.`
    );
  }

  const updated = original.replace(oldText, newText);
  const check = await syntaxCheck(p, updated);
  if (check.checked && !check.ok) {
    return (
      `error: edit would break ${p} — REJECTED and NOT applied.\n${check.error}\n` +
      `Fix the syntax in new_text and retry.`
    );
  }

  await writeFile(full, updated, "utf8");
  return (
    `edited ${p}${normalized ? " (line endings normalized)" : ""}${check.checked ? " · syntax ✓" : ""}\n` +
    redisplay(updated, newText)
  );
}

// ---------------- search tool ----------------

/** Recursive code search across the workspace: regex (or literal fallback),
 *  file:line matches, capped. Pure Node — no grep binary needed. */
export async function toolSearchCode(
  dir: string,
  args: { pattern: string; glob?: string; maxResults?: number },
): Promise<string> {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) return "error: pattern is required";
  const glob = args.glob ? String(args.glob).toLowerCase() : undefined;
  const maxResults = Math.min(200, Math.max(1, Number(args.maxResults) || 50));
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    if (hits.length >= maxResults) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) {
        await walk(path.join(d, e.name), rel);
      } else {
        if (glob && !rel.toLowerCase().endsWith(glob.replace(/\*/g, "")) && !new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i").test(rel)) continue;
        const content = await readFile(path.join(d, e.name), "utf8").catch(() => "");
        if (!content) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
    }
  };
  await walk(dir, "");
  return hits.length ? `${hits.length} match(es):\n` + hits.join("\n") : "no matches";
}

// ---------------- test tool ----------------

/**
 * Run the workspace's tests. Auto-detects: `npm test` when a package.json
 * with a test script exists, else the Node built-in runner (`node --test`)
 * when *.test.{js,mjs,cjs,ts} files exist. A custom command may be given
 * (still allowlist-checked). 60s budget — tests are slower than commands.
 */
export async function toolRunTests(
  dir: string,
  args: { command?: string },
  extraAllow: string[] = [],
  execTarget?: import("./workspace-isolation").ExecTarget,
): Promise<string> {
  const hasPkg = await readFile(path.join(dir, "package.json"), "utf8").catch(() => "");
  let cmd = String(args.command ?? "").trim();
  if (!cmd) {
    if (hasPkg) {
      try {
        const pkg = JSON.parse(hasPkg);
        if (pkg?.scripts?.test) cmd = "npm test";
      } catch {
        /* fall through */
      }
    }
    if (!cmd) {
      const files: string[] = [];
      const walk = async (d: string, prefix: string) => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const rel = prefix ? prefix + "/" + e.name : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), rel);
          else if (/\.test\.(js|mjs|cjs|ts)$/.test(e.name)) files.push(rel);
        }
      };
      await walk(dir, "");
      if (files.length) cmd = "node --test";
      else return "no tests found — write *.test.js files or add a package.json test script first";
    }
  }
  const out = await toolRunCommand(dir, cmd, 60_000, extraAllow, execTarget);
  return `[${cmd}]\n${out}`;
}

// ---------------- GitHub tool ----------------

export function githubToken(opts: { githubToken?: string }): string | undefined {
  return opts.githubToken || process.env.GITHUB_TOKEN || undefined;
}

async function gh(pathname: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch("https://api.github.com" + pathname, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body?.message ?? res.statusText}`);
  return body;
}

/**
 * Publish files to a GitHub repo using the REST git-data API: create blobs,
 * build a tree on top of the branch head, commit, update the ref.
 * Works without a local git binary; every failure is the real GitHub error.
 */
export async function toolGithubPublish(
  dir: string,
  args: { repo: string; message: string; files: { path: string; content: string }[]; branch?: string },
  token?: string
): Promise<string> {
  if (!token) return "error: GitHub is not connected — add a token (GITHUB_TOKEN or the space's GitHub setting)";
  if (!args.files?.length) return "error: no files to publish";
  const branch = args.branch || "main";
  const repo = args.repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

  // Resolve the branch head (repo may be empty — then no parent).
  let parentSha: string | undefined;
  let baseTree: string | undefined;
  try {
    const ref = await gh(`/repos/${repo}/git/ref/heads/${branch}`, token);
    parentSha = ref.object.sha;
    const commit = await gh(`/repos/${repo}/git/commits/${parentSha}`, token);
    baseTree = commit.tree.sha;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!/404|409/.test(msg)) return `error: ${msg}`;
    // branch/repo not found → first commit without parent (repo must exist)
  }

  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const f of args.files) {
    const blob = await gh(`/repos/${repo}/git/blobs`, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(`/repos/${repo}/git/trees`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }),
  });
  const commit = await gh(`/repos/${repo}/git/commits`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: args.message, tree: newTree.sha, parents: parentSha ? [parentSha] : [] }),
  });
  try {
    await gh(`/repos/${repo}/git/refs/heads/${branch}`, token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: commit.sha }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/404|422/.test(msg)) {
      // branch doesn't exist yet — create it
      await gh(`/repos/${repo}/git/refs`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    } else return `error: ${msg}`;
  }
  return `pushed ${args.files.length} file(s) to ${repo}@${branch} — commit ${String(commit.sha).slice(0, 8)}`;
}

// ---------------- dispatch ----------------

export type ToolAction = { tool: string; args: Record<string, any> };

export interface ToolOutcome {
  tool: string;
  input: Record<string, any>;
  output: string;
  ok: boolean;
  ms: number;
}

export async function executeTool(
  spaceId: string,
  action: ToolAction,
  opts: {
    githubToken?: string;
    extraAllow?: string[];
    execTarget?: import("./workspace-isolation").ExecTarget;
    browserEngine?: import("./browser").BrowserEngine;
  } = {}
): Promise<ToolOutcome> {
  const dir = await ensureWorkspace(spaceId);
  const t0 = Date.now();
  const run = async (): Promise<string> => {
    switch (action.tool) {
      case "write_file":
        return toolWriteFile(dir, String(action.args.path ?? ""), String(action.args.content ?? ""));
      case "read_file":
        return toolReadFile(dir, String(action.args.path ?? ""), {
          startLine: action.args.startLine ? Number(action.args.startLine) : undefined,
          endLine: action.args.endLine ? Number(action.args.endLine) : undefined,
        });
      case "edit_file":
        return toolEditFile(dir, {
          path: String(action.args.path ?? ""),
          old_text: String(action.args.old_text ?? ""),
          new_text: String(action.args.new_text ?? ""),
        });
      case "list_files":
        return toolListFiles(dir);
      case "delete_file":
        return toolDeleteFile(dir, String(action.args.path ?? ""));
      case "run_command":
        return toolRunCommand(dir, String(action.args.command ?? ""), 20_000, opts.extraAllow ?? [], opts.execTarget);
      case "search_code":
        return toolSearchCode(dir, {
          pattern: String(action.args.pattern ?? ""),
          glob: action.args.glob ? String(action.args.glob) : undefined,
          maxResults: action.args.maxResults ? Number(action.args.maxResults) : undefined,
        });
      case "run_tests":
        return toolRunTests(dir, { command: action.args.command ? String(action.args.command) : undefined }, opts.extraAllow ?? [], opts.execTarget);
      case "fetch_url":
        return toolFetchUrl(String(action.args.url ?? ""));
      case "browser_navigate":
        return (await import("./browser")).toolBrowserNavigate(spaceId, String(action.args.url ?? ""), opts.browserEngine);
      case "browser_extract":
        return (await import("./browser")).toolBrowserExtract(
          spaceId,
          String(action.args.selector ?? "body"),
          action.args.limit ? Number(action.args.limit) : 10,
          opts.browserEngine,
        );
      case "browser_screenshot":
        return (await import("./browser")).toolBrowserScreenshot(spaceId, opts.browserEngine);
      case "browser_click":
        return (await import("./browser")).toolBrowserClick(spaceId, String(action.args.selector ?? ""), opts.browserEngine);
      case "browser_fill":
        return (await import("./browser")).toolBrowserFill(
          spaceId,
          String(action.args.selector ?? ""),
          String(action.args.value ?? ""),
          opts.browserEngine,
        );
      case "github_publish":
        return toolGithubPublish(
          dir,
          {
            repo: String(action.args.repo ?? ""),
            message: String(action.args.message ?? "update from Arena space"),
            files: Array.isArray(action.args.files)
              ? action.args.files.map((f: any) => ({ path: String(f.path), content: String(f.content ?? "") }))
              : [],
            branch: action.args.branch ? String(action.args.branch) : undefined,
          },
          githubToken(opts)
        );
      default:
        return `error: unknown tool "${action.tool}"`;
    }
  };
  let output: string;
  let ok = true;
  try {
    output = await run();
    if (output.startsWith("error:") || output.startsWith("refused:")) ok = false;
  } catch (e) {
    ok = false;
    output = `error: ${e instanceof Error ? e.message : "tool failed"}`;
  }
  return { tool: action.tool, input: action.args, output, ok, ms: Date.now() - t0 };
}
