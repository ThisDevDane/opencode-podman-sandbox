import { isAbsolute, posix } from "node:path";

export interface RunInput {
  command: string;
  sandboxId?: string;
  keep?: boolean;
  image?: string;
  network?: "none" | "pasta";
  workdir?: string;
  timeoutMs?: number;
}

export interface SandboxOptions {
  podman: string;
  fallbackImage: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  maxSnapshotBytes: number;
  maxSnapshotFiles: number;
  maxSandboxes: number;
  memory: string;
  cpus: number;
  pidsLimit: number;
}

export function imageReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-zA-Z0-9_./:@+-]+$/.test(value)
  ) {
    throw new Error(
      "Use a fully qualified image reference, such as docker.io/library/debian:trixie-slim.",
    );
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

export function sandboxOptions(input: Record<string, unknown> = {}): SandboxOptions {
  const known = new Set([
    "podman",
    "fallbackImage",
    "timeoutMs",
    "maxTimeoutMs",
    "maxOutputBytes",
    "maxSnapshotBytes",
    "maxSnapshotFiles",
    "maxSandboxes",
    "memory",
    "cpus",
    "pidsLimit",
  ]);
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      throw new Error(`Unknown sandbox option: ${name}`);
    }
  }
  const podman = input.podman ?? "podman";
  if (typeof podman !== "string" || (podman !== "podman" && !isAbsolute(podman))) {
    throw new Error("podman must be 'podman' or an absolute executable path.");
  }
  const memory = input.memory ?? "1g";
  if (typeof memory !== "string" || !/^[1-9]\d*[bkmg]$/i.test(memory)) {
    throw new Error("memory must be a positive size, such as 512m or 1g.");
  }
  const maxTimeoutMs = positiveInteger(input.maxTimeoutMs, 600_000, "maxTimeoutMs", 3_600_000);
  return {
    podman,
    fallbackImage: imageReference(input.fallbackImage ?? "docker.io/library/debian:trixie-slim"),
    timeoutMs: positiveInteger(
      input.timeoutMs,
      Math.min(120_000, maxTimeoutMs),
      "timeoutMs",
      maxTimeoutMs,
    ),
    maxTimeoutMs,
    maxOutputBytes: positiveInteger(input.maxOutputBytes, 65_536, "maxOutputBytes", 1_048_576),
    maxSnapshotBytes: positiveInteger(
      input.maxSnapshotBytes,
      100 * 1024 * 1024,
      "maxSnapshotBytes",
    ),
    maxSnapshotFiles: positiveInteger(input.maxSnapshotFiles, 10_000, "maxSnapshotFiles"),
    maxSandboxes: positiveInteger(input.maxSandboxes, 4, "maxSandboxes", 32),
    memory,
    cpus: positiveInteger(input.cpus, 2, "cpus", 128),
    pidsLimit: positiveInteger(input.pidsLimit, 256, "pidsLimit", 65_536),
  };
}

export function runSettings(input: RunInput, options: SandboxOptions) {
  if (typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0")) {
    throw new Error("command must be a non-empty shell command without NUL bytes.");
  }
  if (input.network !== undefined && input.network !== "none" && input.network !== "pasta") {
    throw new Error("network must be none or pasta.");
  }
  if (input.image !== undefined) {
    imageReference(input.image);
  }
  if (input.sandboxId && (input.image !== undefined || input.network !== undefined)) {
    throw new Error("Image and network cannot change when reusing a sandbox.");
  }

  const timeoutMs = input.timeoutMs ?? options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > options.maxTimeoutMs) {
    throw new Error(`timeoutMs must be between 1 and ${options.maxTimeoutMs}.`);
  }

  const workdir = input.workdir ?? ".";
  const normalizedWorkdir = posix.normalize(workdir);
  if (
    isAbsolute(workdir) ||
    workdir.includes("\0") ||
    normalizedWorkdir === ".." ||
    normalizedWorkdir.startsWith("../")
  ) {
    throw new Error("workdir must be relative to /workspace, without escaping it.");
  }

  return { timeoutMs, workdir };
}
