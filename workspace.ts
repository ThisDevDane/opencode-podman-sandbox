import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SandboxOptions } from "./config.ts";
import { hasErrorCode } from "./errors.ts";
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

function createEntry(content: Buffer, mode: string, kind: FileEntry["kind"]): FileEntry {
  const entry: FileEntry = {
    kind,
    mode,
    bytes: content.length,
    hash: createHash("sha256").update(content).digest("hex"),
  };
  if (content.length <= PREVIEW_BYTES && !content.includes(0)) {
    entry.text = content.toString("utf8");
  }
  return entry;
}

function fileMode(mode: number): string {
  return mode & 0o111 ? "100755" : "100644";
}

export async function readBounded(path: string, limit: number): Promise<Buffer> {
  // The scanned workspace is writable by the sandboxed process. Do not follow a replacement link.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new Error(`File is not regular or exceeds ${limit} bytes.`);
    }
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, limit - bytesReadTotal + 1));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) {
        return Buffer.concat(chunks);
      }
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > limit) {
        throw new Error(`File exceeds ${limit} bytes.`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

async function pathsIn(root: string, limit: number, signal?: AbortSignal) {
  const relativePaths: string[] = [];
  let visitedEntries = 0;
  let reachedLimit = false;

  async function walkDirectory(directory: string) {
    signal?.throwIfAborted();
    for await (const directoryEntry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (visitedEntries++ >= limit * 4 + 100) {
        reachedLimit = true;
        break;
      }
      const absolutePath = join(directory, directoryEntry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (excluded(relativePath)) {
        continue;
      }
      if (directoryEntry.isDirectory()) {
        await walkDirectory(absolutePath);
      } else {
        if (relativePaths.length >= limit) {
          reachedLimit = true;
          break;
        }
        relativePaths.push(relativePath);
      }
      if (reachedLimit) {
        break;
      }
    }
  }

  await walkDirectory(root);
  return { paths: relativePaths.sort(), limited: reachedLimit };
}

async function selectedPaths(
  root: string,
  limit: number,
  runner: Runner,
  signal?: AbortSignal,
): Promise<string[]> {
  const gitListing = await runner(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { signal, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (gitListing.timedOut || gitListing.aborted || gitListing.truncated) {
    throw new Error("Could not enumerate project files completely.");
  }
  if (gitListing.exitCode === 0) {
    return [...new Set(gitListing.stdout.split("\0").filter(Boolean))].sort();
  }
  // Non-Git directories are supported, but other Git failures must not cause a wider copy.
  if (!gitListing.stderr.includes("not a git repository")) {
    throw new Error(`Could not list project files: ${gitListing.stderr}`);
  }
  const directoryListing = await pathsIn(root, limit, signal);
  if (directoryListing.limited) {
    throw new Error(`Snapshot listing exceeds ${limit} files or its directory traversal limit.`);
  }
  return directoryListing.paths;
}

// Checks ancestors too: a tracked file may now live beneath a symlinked directory.
export async function safePath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.includes("\0") || !inside(root, resolve(root, name))) {
    throw new Error("Path must be relative to the sandbox workspace.");
  }
  const path = resolve(root, name);
  const parent = await realpath(dirname(path));
  if (!inside(root, parent)) {
    throw new Error("Path traverses a symlink outside the workspace.");
  }
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
  let copiedBytes = 0;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await selectedPaths(root, limits.maxSnapshotFiles, runner, signal)) {
    signal?.throwIfAborted();
    if (excluded(name)) {
      omitted.push(name);
      continue;
    }
    if (files.size >= limits.maxSnapshotFiles) {
      throw new Error(`Snapshot exceeds ${limits.maxSnapshotFiles} files.`);
    }
    let path: string;
    try {
      path = await safePath(root, name);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      omitted.push(name);
      continue;
    }
    const target = join(destination, name);
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(path);
      if (isAbsolute(linkTarget) || !inside(root, resolve(dirname(path), linkTarget))) {
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
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
      await mkdir(dirname(target), { recursive: true });
      await symlink(linkTarget, target);
      files.set(name, createEntry(Buffer.from(linkTarget), "120000", "symlink"));
    } else {
      if (copiedBytes + stat.size > limits.maxSnapshotBytes) {
        throw new Error(`Snapshot exceeds ${limits.maxSnapshotBytes} bytes.`);
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
      await chmod(target, stat.mode & 0o777);
      const content = await readBounded(target, limits.maxSnapshotBytes - copiedBytes);
      copiedBytes += content.length;
      files.set(name, createEntry(content, fileMode(stat.mode), "file"));
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
  let inspectedBytes = 0;
  const listing = await pathsIn(root, limits.maxSnapshotFiles, signal);
  const uninspected = new Set<string>();
  let incompleteListing = listing.limited;
  if (listing.limited) {
    omitted.push("Listing limit reached; remaining files were not inspected.");
  }
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
      files.set(name, createEntry(Buffer.from(await readlink(path)), "120000", "symlink"));
    } else if (stat.isFile()) {
      if (inspectedBytes + stat.size > limits.maxSnapshotBytes) {
        omitted.push(name);
        uninspected.add(name);
        continue;
      }
      try {
        const content = await readBounded(path, limits.maxSnapshotBytes - inspectedBytes);
        inspectedBytes += content.length;
        files.set(name, createEntry(content, fileMode(stat.mode), "file"));
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

function changeStatus(before?: FileEntry, after?: FileEntry): FileChange["status"] {
  if (!before) {
    return "added";
  }
  if (!after) {
    return "deleted";
  }
  return "modified";
}

function diffPath(path: string, side: "a" | "b"): string {
  return JSON.stringify(`${side}/${path}`);
}

function fileDiffHeader(path: string, before?: FileEntry, after?: FileEntry): string {
  let header = `diff --git ${diffPath(path, "a")} ${diffPath(path, "b")}\n`;
  if (!before && after) {
    header += `new file mode ${after.mode}\n`;
  } else if (before && !after) {
    header += `deleted file mode ${before.mode}\n`;
  } else if (before && after && before.mode !== after.mode) {
    header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
  }
  return header;
}

function splitDiffLines(text = ""): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function formatDiffLines(lines: string[], prefix: "-" | "+", originalText?: string): string {
  if (!lines.length) {
    return "";
  }
  let formatted = lines.map((line) => `${prefix}${line}\n`).join("");
  if (!originalText?.endsWith("\n")) {
    formatted += "\\ No newline at end of file\n";
  }
  return formatted;
}

function contentDiff(path: string, before?: FileEntry, after?: FileEntry): string {
  if ((before && before.text === undefined) || (after && after.text === undefined)) {
    return "Binary or large file changed; content omitted.\n";
  }
  if (before?.text === after?.text) {
    return "";
  }

  const previousLines = splitDiffLines(before?.text);
  const currentLines = splitDiffLines(after?.text);
  let diff = "";
  if (previousLines.length || currentLines.length) {
    const previousStart = previousLines.length ? 1 : 0;
    const currentStart = currentLines.length ? 1 : 0;
    const previousPath = before ? diffPath(path, "a") : "/dev/null";
    const currentPath = after ? diffPath(path, "b") : "/dev/null";
    diff += `--- ${previousPath}\n+++ ${currentPath}\n`;
    diff += `@@ -${previousStart},${previousLines.length} +${currentStart},${currentLines.length} @@\n`;
  }
  diff += formatDiffLines(previousLines, "-", before?.text);
  diff += formatDiffLines(currentLines, "+", after?.text);
  return diff;
}

export function workspaceDiff(before: Snapshot, after: Snapshot, maxBytes = 65_536) {
  const changes: FileChange[] = [];
  let changeCount = 0;
  let patch = "";
  let truncated = after.omitted.length > 0;
  const allPaths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();

  for (const path of allPaths) {
    const previous = before.files.get(path);
    const current = after.files.get(path);
    if (previous?.hash === current?.hash && previous?.mode === current?.mode) {
      continue;
    }
    // A scan limit is not a deletion. Never report unknown files as deleted.
    if (!current && (after.incompleteListing || after.uninspected?.has(path))) {
      truncated = true;
      continue;
    }
    changeCount++;
    if (changes.length < 200) {
      changes.push({
        path,
        status: changeStatus(previous, current),
        beforeBytes: previous?.bytes,
        afterBytes: current?.bytes,
      });
    } else {
      truncated = true;
    }

    const filePatch =
      fileDiffHeader(path, previous, current) + contentDiff(path, previous, current);
    if (Buffer.byteLength(patch) + Buffer.byteLength(filePatch) <= maxBytes) {
      patch += filePatch;
    } else {
      truncated = true;
    }
  }
  return { changes, changeCount, patch, truncated, omitted: after.omitted.slice(0, 100) };
}
