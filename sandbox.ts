import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import {
  imageReference,
  runSettings,
  sandboxOptions,
  type RunInput,
  type SandboxOptions,
} from "./config.ts";
import { hasErrorCode } from "./errors.ts";
import { runProcess, succeeded, type ProcessOptions, type Runner } from "./process.ts";
import {
  readBounded,
  safePath,
  scanWorkspace,
  snapshotProject,
  workspaceDiff,
  type Snapshot,
} from "./workspace.ts";

export type { RunInput } from "./config.ts";

const SANDBOX_LABEL = "io.github.thisdevdane.opencode-podman-sandbox=true";
const KEEP_ALIVE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";
const EXPERIMENT_NOTE = [
  "The command ran in a disposable copy.",
  "No changes have been applied to the source project.",
  "Diffs cover /workspace only, not installed system packages or external services.",
].join(" ");

interface Sandbox {
  id: string;
  owner: string;
  source: string;
  directory: string;
  workspace: string;
  container: string;
  image: string;
  network: "none" | "pasta";
  baseline: Snapshot;
  busy: boolean;
  created: string;
}

export class SandboxManager {
  readonly options: SandboxOptions;
  readonly #runner: Runner;
  readonly #sandboxes = new Map<string, Sandbox>();
  readonly #shutdownController = new AbortController();
  readonly #activeOperations = new Set<Promise<unknown>>();
  #pendingCreations = 0;
  #closed = false;

  constructor(options: Record<string, unknown> = {}, runner: Runner = runProcess) {
    this.options = sandboxOptions(options);
    this.#runner = runner;
  }

  async #runPodman(args: string[], processOptions: ProcessOptions = {}) {
    return this.#runner(this.options.podman, ["--remote=false", ...args], {
      timeoutMs: this.options.maxTimeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      ...processOptions,
    });
  }

  async status(signal?: AbortSignal) {
    if (
      process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      process.getuid() === 0
    ) {
      throw new Error("This plugin requires local Linux Podman running as a non-root user.");
    }
    const result = succeeded(
      await this.#runPodman(["info", "--format=json"], { signal }),
      "Rootless Podman check",
    );
    const info = JSON.parse(result.stdout) as {
      host?: { security?: { rootless?: boolean } };
      version?: { Version?: string; version?: string };
    };
    if (info.host?.security?.rootless !== true) {
      throw new Error(
        "Podman must report host.security.rootless=true. Configure rootless Podman before running experiments.",
      );
    }
    return {
      rootless: true,
      version: info.version?.Version ?? info.version?.version,
      activeSandboxes: this.#sandboxes.size,
    };
  }

  #trackOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("Sandbox plugin is unloading."));
    }
    const operation = work();
    this.#activeOperations.add(operation);
    // Track cleanup without turning a handled caller error into an unhandled rejection.
    void operation.finally(() => this.#activeOperations.delete(operation)).catch(() => {});
    return operation;
  }

  #operationSignal(signal?: AbortSignal): AbortSignal {
    const signals = [this.#shutdownController.signal];
    if (signal) {
      signals.push(signal);
    }
    return AbortSignal.any(signals);
  }

  #getIdleSandbox(owner: string, id: string): Sandbox {
    const sandbox = this.#sandboxes.get(id);
    if (!sandbox || sandbox.owner !== owner) {
      throw new Error("Sandbox not found in this session.");
    }
    if (sandbox.busy) {
      throw new Error("Sandbox is busy. Wait for its current operation to finish.");
    }
    return sandbox;
  }

  async #prepareWorkspace(
    owner: string,
    source: string,
    input: RunInput,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    if (this.#sandboxes.size + this.#pendingCreations >= this.options.maxSandboxes) {
      throw new Error("Sandbox limit reached. Remove a retained sandbox first.");
    }
    this.#pendingCreations++;
    let directory: string | undefined;
    try {
      await this.status(signal);
      directory = await mkdtemp(join(tmpdir(), "opencode-podman-sandbox-"));
      if (directory.includes(":")) {
        throw new Error(
          "Podman sandbox temporary directory cannot contain a colon. Set TMPDIR to a plain local path.",
        );
      }
      const workspace = join(directory, "workspace");
      const baseline = await snapshotProject(source, workspace, this.options, signal, this.#runner);
      const id = randomUUID();
      const sandbox: Sandbox = {
        id,
        owner,
        source,
        directory,
        workspace,
        baseline,
        container: `opencode-sandbox-${id}`,
        image: imageReference(input.image ?? this.options.fallbackImage),
        network: input.network ?? "none",
        busy: true,
        created: new Date().toISOString(),
      };
      // Register before provisioning so a failed create can still be cleaned up or retried.
      this.#sandboxes.set(id, sandbox);
      return sandbox;
    } catch (error) {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    } finally {
      // Once registered, the sandbox is counted by #sandboxes rather than this reservation.
      this.#pendingCreations--;
    }
  }

  #containerCreateArgs(sandbox: Sandbox): string[] {
    return [
      "create",
      "--name",
      sandbox.container,
      "--label",
      SANDBOX_LABEL,
      "--network",
      sandbox.network,
      "--http-proxy=false",
      "--image-volume=ignore",
      "--user",
      "0:0",
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/root",
      "--memory",
      this.options.memory,
      "--cpus",
      String(this.options.cpus),
      "--pids-limit",
      String(this.options.pidsLimit),
      "--security-opt",
      "no-new-privileges",
      "--volume",
      `${sandbox.workspace}:/workspace:rw,Z`,
      "--entrypoint",
      "/bin/sh",
      sandbox.image,
      "-c",
      KEEP_ALIVE_COMMAND,
    ];
  }

  async #create(
    owner: string,
    source: string,
    input: RunInput,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    const sandbox = await this.#prepareWorkspace(owner, source, input, signal);
    try {
      succeeded(
        await this.#runPodman(this.#containerCreateArgs(sandbox), { signal }),
        "Creating sandbox container",
      );
      succeeded(
        await this.#runPodman(["start", sandbox.container], { signal }),
        "Starting sandbox container",
      );
      return sandbox;
    } catch (error) {
      try {
        await this.#destroy(sandbox);
      } catch (cleanupError) {
        sandbox.busy = false;
        throw new AggregateError(
          [error, cleanupError],
          `Sandbox creation failed; cleanup also failed. Retained sandbox ID: ${sandbox.id}`,
        );
      }
      throw error;
    }
  }

  async #destroy(sandbox: Sandbox) {
    succeeded(
      await this.#runPodman(
        ["rm", "--force", "--time=0", "--volumes", "--ignore", sandbox.container],
        { timeoutMs: 30_000 },
      ),
      `Removing container ${sandbox.container}`,
    );
    try {
      await rm(sandbox.directory, { recursive: true, force: true });
    } catch (error) {
      if (!hasErrorCode(error, "EACCES", "EPERM")) {
        throw error;
      }
      // Experiments can chown files to subordinate IDs. Only delete this manager's private directory.
      succeeded(
        await this.#runPodman(["unshare", "rm", "-rf", "--", sandbox.directory], {
          timeoutMs: 30_000,
        }),
        `Removing workspace ${sandbox.directory}`,
      );
    }
    this.#sandboxes.delete(sandbox.id);
  }

  list(owner: string) {
    return [...this.#sandboxes.values()]
      .filter((sandbox) => sandbox.owner === owner)
      .map((sandbox) => ({
        sandboxId: sandbox.id,
        image: sandbox.image,
        network: sandbox.network,
        source: sandbox.source,
        busy: sandbox.busy,
        created: sandbox.created,
      }));
  }

  run(owner: string, source: string, input: RunInput, signal?: AbortSignal) {
    return this.#trackOperation(async () => {
      const { timeoutMs, workdir } = runSettings(input, this.options);
      const lifetime = this.#operationSignal(signal);
      lifetime.throwIfAborted();
      const root = await realpath(source);
      const sandbox = input.sandboxId
        ? this.#getIdleSandbox(owner, input.sandboxId)
        : await this.#create(owner, root, input, lifetime);
      if (sandbox.source !== root) {
        throw new Error("Sandbox belongs to a different project directory.");
      }
      sandbox.busy = true;
      let retainSandbox = input.keep ?? Boolean(input.sandboxId);
      try {
        const result = await this.#runPodman(
          [
            "exec",
            "--workdir",
            posix.join("/workspace", workdir),
            sandbox.container,
            "/bin/sh",
            "-c",
            input.command,
          ],
          { signal: lifetime, timeoutMs },
        );
        // Killing the client does not reliably kill podman exec. Destroy the container too.
        if (result.timedOut || result.aborted) {
          retainSandbox = false;
        }
        let diff: ReturnType<typeof workspaceDiff> | undefined;
        let inspectionError: string | undefined;
        if (!result.timedOut && !result.aborted) {
          try {
            diff = await this.#workspaceChanges(sandbox, lifetime);
          } catch (error) {
            inspectionError = String(error);
          }
        }
        // Cancellation can arrive after exec exits, while files are being inspected.
        const aborted = result.aborted || lifetime.aborted;
        if (aborted) {
          retainSandbox = false;
        }
        return {
          ...result,
          aborted,
          sandboxId: retainSandbox ? sandbox.id : null,
          retained: retainSandbox,
          image: sandbox.image,
          network: sandbox.network,
          diff,
          inspectionError,
          omittedFromSnapshot: sandbox.baseline.omitted.slice(0, 100),
          omittedFromSnapshotCount: sandbox.baseline.omitted.length,
          note: EXPERIMENT_NOTE,
        };
      } catch (error) {
        retainSandbox = false;
        throw error;
      } finally {
        try {
          if (!retainSandbox) {
            await this.#destroy(sandbox);
          }
        } finally {
          sandbox.busy = false;
        }
      }
    });
  }

  async #workspaceChanges(sandbox: Sandbox, signal: AbortSignal) {
    const current = await scanWorkspace(sandbox.workspace, this.options, signal);
    return workspaceDiff(sandbox.baseline, current, this.options.maxOutputBytes);
  }

  async #readArtifact(sandbox: Sandbox, path: string) {
    const target = await safePath(sandbox.workspace, path);
    const stat = await lstat(target);
    if (!stat.isFile()) {
      throw new Error("Only regular files can be read. Symlinks are not followed.");
    }
    if (stat.size > this.options.maxOutputBytes) {
      throw new Error(
        `File exceeds ${this.options.maxOutputBytes} bytes. Inspect a smaller artifact inside the container.`,
      );
    }
    const content = await readBounded(target, this.options.maxOutputBytes);
    if (content.includes(0)) {
      throw new Error("File is binary. Inspect it with a command inside the container.");
    }
    return { path, content: content.toString("utf8") };
  }

  inspect(owner: string, id: string, path?: string, signal?: AbortSignal) {
    return this.#trackOperation(async () => {
      const sandbox = this.#getIdleSandbox(owner, id);
      sandbox.busy = true;
      try {
        const lifetime = this.#operationSignal(signal);
        lifetime.throwIfAborted();
        if (path !== undefined) {
          return { sandboxId: id, ...(await this.#readArtifact(sandbox, path)) };
        }
        return { sandboxId: id, ...(await this.#workspaceChanges(sandbox, lifetime)) };
      } finally {
        sandbox.busy = false;
      }
    });
  }

  remove(owner: string, id: string) {
    return this.#trackOperation(async () => {
      const sandbox = this.#getIdleSandbox(owner, id);
      sandbox.busy = true;
      try {
        await this.#destroy(sandbox);
        return { removed: id };
      } finally {
        sandbox.busy = false;
      }
    });
  }

  async dispose() {
    this.#closed = true;
    this.#shutdownController.abort();
    await Promise.allSettled(this.#activeOperations);
    const results = await Promise.allSettled(
      [...this.#sandboxes.values()].map((sandbox) => this.#destroy(sandbox)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Some sandbox resources could not be removed. Use podman ps -a --filter label=${SANDBOX_LABEL} to inspect leftovers.`,
      );
    }
  }
}
