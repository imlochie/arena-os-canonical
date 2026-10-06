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

export const WORKSPACE_ROOT = path.resolve(process.cwd(), ".data/space-workspaces");

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
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return `wrote ${p} (${content.length} bytes)`;
}

export async function toolReadFile(dir: string, p: string): Promise<string> {
  const full = safePath(dir, p);
  const content = await readFile(full, "utf8");
  return content.length > 8000 ? content.slice(0, 8000) + "\n…(truncated)" : content;
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

export function commandAllowed(cmd: string): boolean {
  const base = cmd.trim().split(/\s+/)[0];
  return (COMMAND_ALLOWLIST as readonly string[]).includes(base);
}

export async function toolRunCommand(dir: string, cmd: string, timeoutMs = 20_000): Promise<string> {
  if (!commandAllowed(cmd)) {
    return `refused: "${cmd.trim().split(/\s+/)[0]}" is not on the tool allowlist (${COMMAND_ALLOWLIST.join(", ")})`;
  }
  return new Promise((resolve) => {
    const parts = cmd.trim().split(/\s+/);
    const child = spawn(parts[0], parts.slice(1), { cwd: dir, timeout: timeoutMs });
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
  opts: { githubToken?: string } = {}
): Promise<ToolOutcome> {
  const dir = await ensureWorkspace(spaceId);
  const t0 = Date.now();
  const run = async (): Promise<string> => {
    switch (action.tool) {
      case "write_file":
        return toolWriteFile(dir, String(action.args.path ?? ""), String(action.args.content ?? ""));
      case "read_file":
        return toolReadFile(dir, String(action.args.path ?? ""));
      case "list_files":
        return toolListFiles(dir);
      case "delete_file":
        return toolDeleteFile(dir, String(action.args.path ?? ""));
      case "run_command":
        return toolRunCommand(dir, String(action.args.command ?? ""));
      case "fetch_url":
        return toolFetchUrl(String(action.args.url ?? ""));
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
