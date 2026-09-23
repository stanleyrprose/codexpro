import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const WORKSPACE_IDENTITY_FILES = [
  "AGENTS.md",
  "AGENTS.override.md",
  ".agents.md",
  "agents.md",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.lock",
  "Cargo.lock",
  "go.sum"
] as const;

function runGit(root: string, args: string[], maxBytes = 25_000_000): string | undefined {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout || "";
}

export function resolvedGitRevision(root: string): string | undefined {
  const value = runGit(root, ["rev-parse", "HEAD"], 1_000_000);
  return value?.trim() || undefined;
}

export function dirtyGitState(root: string): "clean" | "dirty" | "unknown" {
  const value = runGit(root, ["status", "--porcelain"], 25_000_000);
  if (value === undefined) return "unknown";
  return value.length ? "dirty" : "clean";
}

export function workspaceIdentityFingerprint(options: {
  root: string;
  revision?: string;
  bashMode: string;
  writeMode: string;
  toolMode: string;
}): { fingerprint: string; basis: string[] } {
  const hash = createHash("sha256");
  const basis: string[] = [];
  const add = (name: string, value: string): void => {
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
    basis.push(name);
  };
  add("git_revision", options.revision ?? "non-git");
  add("bash_mode", options.bashMode);
  add("write_mode", options.writeMode);
  add("tool_mode", options.toolMode);
  for (const rel of WORKSPACE_IDENTITY_FILES) {
    try {
      const abs = path.join(options.root, rel);
      const stat = fs.lstatSync(abs);
      if (!stat.isFile()) continue;
      const bytes = fs.readFileSync(abs);
      add(`file:${rel}`, createHash("sha256").update(bytes).digest("hex"));
    } catch {
      // Optional identity inputs are absent in many repositories.
    }
  }
  return { fingerprint: hash.digest("hex"), basis };
}

function normalizeContextDir(contextDir: string): string {
  return contextDir.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function sha256File(absPath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(absPath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function worktreeFingerprint(root: string, contextDir = ".ai-bridge"): string | undefined {
  const context = normalizeContextDir(contextDir);
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 25_000_000);
  const staged = runGit(root, ["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--", ".", `:(exclude)${context}`], 25_000_000);
  if (status === undefined || staged === undefined) return undefined;

  const hash = createHash("sha256");
  hash.update("staged-raw\0");
  hash.update(staged);
  hash.update("\0");

  const tokens = status.split("\0").filter(Boolean);
  const records: Array<{ code: string; paths: string[] }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const currentPath = entry.slice(3);
    const paths = [currentPath];
    if (/[RC]/.test(code) && index + 1 < tokens.length) paths.push(tokens[++index]);
    records.push({ code, paths });
  }
  records.sort((a, b) => `${a.code}\0${a.paths.join("\0")}`.localeCompare(`${b.code}\0${b.paths.join("\0")}`));
  for (const record of records) {
    const normalizedPaths = record.paths.map((rel) => rel.replaceAll("\\", "/"));
    if (normalizedPaths.every((rel) => rel === context || rel.startsWith(`${context}/`))) continue;
    hash.update(`status\0${record.code} ${normalizedPaths.join(" -> ")}\0`);
    for (const rel of record.paths) {
      const normalized = rel.replaceAll("\\", "/");
      if (normalized === context || normalized.startsWith(`${context}/`)) continue;
      const abs = path.resolve(root, rel);
      try {
        const stat = fs.lstatSync(abs);
        const type = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
        hash.update(`path=${normalized};type=${type};mode=${stat.mode};size=${stat.size}\0`);
        if (stat.isSymbolicLink()) hash.update(`target=${fs.readlinkSync(abs)}\0`);
        else if (stat.isFile()) hash.update(`sha256=${sha256File(abs)}\0`);
      } catch (error) {
        hash.update(`path=${normalized};unavailable=${error instanceof Error ? error.message : String(error)}\0`);
      }
    }
  }
  return hash.digest("hex");
}
