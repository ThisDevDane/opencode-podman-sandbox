import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  symlink,
  chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxOptions } from "./config.ts";
import { runProcess, type Runner } from "./process.ts";

const OMIT_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".cache",
]);
const OMIT_FILES = new Set([".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const PREVIEW_BYTES = 32_768;

export interface FileEntry {
  kind: "file" | "symlink";
  mode: string;
  hash: string;
  bytes: number;
  text?: string;
}

export interface Snapshot {
  files: Map<string, FileEntry>;
  omitted: string[];
  uninspected?: Set<string>;
  incompleteListing?: boolean;
}

export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export function excluded(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        OMIT_DIRECTORIES.has(part) ||
        OMIT_FILES.has(part) ||
        ((part === ".env" || part.startsWith(".env.")) && !ENV_TEMPLATES.has(part)) ||
        /\.(pem|key)$/i.test(part),
    );
}

function entry(content: Buffer, mode: string, kind: FileEntry["kind"]): FileEntry {
  return {
    kind,
    mode,
    bytes: content.length,
    hash: createHash("sha256").update(content).digest("hex"),
    ...(content.length <= PREVIEW_BYTES && !content.includes(0)
      ? { text: content.toString("utf8") }
      : {}),
  };
}

export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`File is not regular or exceeds ${limit} bytes.`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, limit - bytes + 1));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) return Buffer.concat(chunks);
      bytes += bytesRead;
      if (bytes > limit) throw new Error(`File exceeds ${limit} bytes.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

async function pathsIn(root: string, limit: number, signal?: AbortSignal) {
  const paths: string[] = [];
  let visited = 0;
  let limited = false;
  async function walk(directory: string) {
    signal?.throwIfAborted();
    for await (const item of await opendir(directory)) {
      signal?.throwIfAborted();
      if (visited++ >= limit * 4 + 100) {
        limited = true;
        break;
      }
      const path = join(directory, item.name);
      const name = relative(root, path).split(sep).join("/");
      if (excluded(name)) continue;
      if (item.isDirectory()) await walk(path);
      else {
        if (paths.length >= limit) {
          limited = true;
          break;
        }
        paths.push(name);
      }
      if (limited) break;
    }
  }
  await walk(root);
  return { paths: paths.sort(), limited };
}

async function selectedPaths(
  root: string,
  limit: number,
  runner: Runner,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runner(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { signal, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (result.timedOut || result.aborted || result.truncated)
    throw new Error("Could not enumerate project files completely.");
  if (result.exitCode === 0) return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
  // Non-Git directories are supported, but other Git failures must not cause a wider copy.
  if (!result.stderr.includes("not a git repository"))
    throw new Error(`Could not list project files: ${result.stderr}`);
  const listing = await pathsIn(root, limit, signal);
  if (listing.limited)
    throw new Error(`Snapshot listing exceeds ${limit} files or its directory traversal limit.`);
  return listing.paths;
}

// Checks ancestors too: a tracked file may now live beneath a symlinked directory.
export async function safePath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.includes("\0") || !inside(root, resolve(root, name))) {
    throw new Error("Path must be relative to the sandbox workspace.");
  }
  const path = resolve(root, name);
  const parent = await realpath(dirname(path));
  if (!inside(root, parent)) throw new Error("Path traverses a symlink outside the workspace.");
  return path;
}

export async function snapshotProject(
  source: string,
  destination: string,
  limits: Pick<SandboxOptions, "maxSnapshotBytes" | "maxSnapshotFiles">,
  signal?: AbortSignal,
  runner: Runner = runProcess,
): Promise<Snapshot> {
  const root = await realpath(source);
  const files = new Map<string, FileEntry>();
  const omitted: string[] = [];
  let bytes = 0;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await selectedPaths(root, limits.maxSnapshotFiles, runner, signal)) {
    signal?.throwIfAborted();
    if (excluded(name)) {
      omitted.push(name);
      continue;
    }
    if (files.size >= limits.maxSnapshotFiles)
      throw new Error(`Snapshot exceeds ${limits.maxSnapshotFiles} files.`);
    let path: string;
    try {
      path = await safePath(root, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      omitted.push(name);
      continue;
    }
    const target = join(destination, name);
    if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !inside(root, resolve(dirname(path), link))) {
        omitted.push(name);
        continue;
      }
      // Do not follow even relative links through another link outside the project.
      try {
        if (!inside(root, await realpath(path))) {
          omitted.push(name);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await symlink(link, target);
      files.set(name, entry(Buffer.from(link), "120000", "symlink"));
    } else {
      if (bytes + stat.size > limits.maxSnapshotBytes)
        throw new Error(`Snapshot exceeds ${limits.maxSnapshotBytes} bytes.`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
      await chmod(target, stat.mode & 0o777);
      const content = await readBounded(target, limits.maxSnapshotBytes - bytes);
      bytes += content.length;
      files.set(name, entry(content, stat.mode & 0o111 ? "100755" : "100644", "file"));
    }
  }
  return { files, omitted };
}

export async function scanWorkspace(
  root: string,
  limits: Pick<SandboxOptions, "maxSnapshotBytes" | "maxSnapshotFiles">,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const files = new Map<string, FileEntry>();
  const omitted: string[] = [];
  let bytes = 0;
  const listing = await pathsIn(root, limits.maxSnapshotFiles, signal);
  const uninspected = new Set<string>();
  let incompleteListing = listing.limited;
  if (listing.limited) omitted.push("Listing limit reached; remaining files were not inspected.");
  for (const name of listing.paths) {
    signal?.throwIfAborted();
    if (files.size >= limits.maxSnapshotFiles) {
      omitted.push("File limit reached; remaining files were not inspected.");
      incompleteListing = true;
      break;
    }
    const path = await safePath(root, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      files.set(name, entry(Buffer.from(await readlink(path)), "120000", "symlink"));
    } else if (stat.isFile()) {
      if (bytes + stat.size > limits.maxSnapshotBytes) {
        omitted.push(name);
        uninspected.add(name);
        continue;
      }
      try {
        const content = await readBounded(path, limits.maxSnapshotBytes - bytes);
        bytes += content.length;
        files.set(name, entry(content, stat.mode & 0o111 ? "100755" : "100644", "file"));
      } catch (error) {
        omitted.push(`${name}: ${String(error)}`);
        uninspected.add(name);
      }
    } else {
      omitted.push(name);
      uninspected.add(name);
    }
  }
  return { files, omitted, uninspected, incompleteListing };
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeBytes?: number;
  afterBytes?: number;
}

export function workspaceDiff(before: Snapshot, after: Snapshot, maxBytes = 65_536) {
  const changes: FileChange[] = [];
  let changeCount = 0;
  let patch = "";
  let truncated = after.omitted.length > 0;
  for (const path of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const old = before.files.get(path);
    const next = after.files.get(path);
    if (old?.hash === next?.hash && old?.mode === next?.mode) continue;
    // A scan limit is not a deletion. Never report unknown files as deleted.
    if (!next && (after.incompleteListing || after.uninspected?.has(path))) {
      truncated = true;
      continue;
    }
    changeCount++;
    if (changes.length < 200)
      changes.push({
        path,
        status: !old ? "added" : !next ? "deleted" : "modified",
        beforeBytes: old?.bytes,
        afterBytes: next?.bytes,
      });
    else truncated = true;
    let part = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`;
    if (!old) part += `new file mode ${next!.mode}\n`;
    else if (!next) part += `deleted file mode ${old.mode}\n`;
    else if (old.mode !== next.mode) part += `old mode ${old.mode}\nnew mode ${next.mode}\n`;
    if ((old && old.text === undefined) || (next && next.text === undefined)) {
      part += "Binary or large file changed; content omitted.\n";
    } else if (old?.text !== next?.text) {
      const lines = (text = "") => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
      const previous = lines(old?.text);
      const current = lines(next?.text);
      if (previous.length || current.length) {
        part += `--- ${old ? JSON.stringify(`a/${path}`) : "/dev/null"}\n+++ ${next ? JSON.stringify(`b/${path}`) : "/dev/null"}\n`;
        part += `@@ -${previous.length ? 1 : 0},${previous.length} +${current.length ? 1 : 0},${current.length} @@\n`;
      }
      for (const [items, prefix, text] of [
        [previous, "-", old?.text],
        [current, "+", next?.text],
      ] as const) {
        if (items.length) {
          part += items.map((line) => `${prefix}${line}\n`).join("");
          if (!text?.endsWith("\n")) part += "\\ No newline at end of file\n";
        }
      }
    }
    if (Buffer.byteLength(patch) + Buffer.byteLength(part) <= maxBytes) patch += part;
    else truncated = true;
  }
  return { changes, changeCount, patch, truncated, omitted: after.omitted.slice(0, 100) };
}
