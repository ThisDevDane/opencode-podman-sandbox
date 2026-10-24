import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { imageReference, sandboxOptions, type SandboxOptions } from "./config.ts";
import { runProcess, succeeded, type ProcessOptions, type Runner } from "./process.ts";
import {
  readBounded,
  safePath,
  scanWorkspace,
  snapshotProject,
  workspaceDiff,
  type Snapshot,
} from "./workspace.ts";

export interface RunInput {
  command: string;
  sandboxId?: string;
  keep?: boolean;
  image?: string;
  network?: "none" | "pasta";
  workdir?: string;
  timeoutMs?: number;
}

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
  readonly #lifetime = new AbortController();
  readonly #operations = new Set<Promise<unknown>>();
  #creating = 0;
  #closed = false;

  constructor(options: Record<string, unknown> = {}, runner: Runner = runProcess) {
    this.options = sandboxOptions(options);
    this.#runner = runner;
  }

  async #podman(args: string[], options: ProcessOptions = {}) {
    return this.#runner(this.options.podman, ["--remote=false", ...args], {
      timeoutMs: this.options.maxTimeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      ...options,
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
      await this.#podman(["info", "--format=json"], { signal }),
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

  #track<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Sandbox plugin is unloading."));
    const operation = work();
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }

  #get(owner: string, id: string): Sandbox {
    const sandbox = this.#sandboxes.get(id);
    if (!sandbox || sandbox.owner !== owner) throw new Error("Sandbox not found in this session.");
    if (sandbox.busy) throw new Error("Sandbox is busy. Wait for its current operation to finish.");
    return sandbox;
  }

  async #create(
    owner: string,
    source: string,
    input: RunInput,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    if (this.#sandboxes.size + this.#creating >= this.options.maxSandboxes)
      throw new Error("Sandbox limit reached. Remove a retained sandbox first.");
    this.#creating++;
    let reserved = true;
    let directory: string | undefined;
    let sandbox: Sandbox | undefined;
    try {
      await this.status(signal);
      directory = await mkdtemp(join(tmpdir(), "opencode-podman-sandbox-"));
      if (directory.includes(":"))
        throw new Error(
          "Podman sandbox temporary directory cannot contain a colon. Set TMPDIR to a plain local path.",
        );
      const workspace = join(directory, "workspace");
      const baseline = await snapshotProject(source, workspace, this.options, signal, this.#runner);
      const id = randomUUID();
      sandbox = {
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
      this.#creating--;
      reserved = false;
      succeeded(
        await this.#podman(
          [
            "create",
            "--name",
            sandbox.container,
            "--label",
            "io.github.thisdevdane.opencode-podman-sandbox=true",
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
            `${workspace}:/workspace:rw,Z`,
            "--entrypoint",
            "/bin/sh",
            sandbox.image,
            "-c",
            "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
          ],
          { signal },
        ),
        "Creating sandbox container",
      );
      succeeded(
        await this.#podman(["start", sandbox.container], { signal }),
        "Starting sandbox container",
      );
      return sandbox;
    } catch (error) {
      if (sandbox) {
        try {
          await this.#destroy(sandbox);
        } catch (cleanupError) {
          sandbox.busy = false;
          throw new AggregateError(
            [error, cleanupError],
            `Sandbox creation failed; cleanup also failed. Retained sandbox ID: ${sandbox.id}`,
          );
        }
      } else if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      if (reserved) this.#creating--;
    }
  }

  async #destroy(sandbox: Sandbox) {
    succeeded(
      await this.#podman(
        ["rm", "--force", "--time=0", "--volumes", "--ignore", sandbox.container],
        { timeoutMs: 30_000 },
      ),
      `Removing container ${sandbox.container}`,
    );
    try {
      await rm(sandbox.directory, { recursive: true, force: true });
    } catch (error) {
      if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Experiments can chown files to subordinate IDs. Only delete this manager's private directory.
      succeeded(
        await this.#podman(["unshare", "rm", "-rf", "--", sandbox.directory], {
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
    return this.#track(async () => {
      if (
        typeof input.command !== "string" ||
        !input.command.trim() ||
        input.command.includes("\0")
      )
        throw new Error("command must be a non-empty shell command without NUL bytes.");
      if (input.network !== undefined && input.network !== "none" && input.network !== "pasta")
        throw new Error("network must be none or pasta.");
      if (input.image !== undefined) imageReference(input.image);
      if (input.sandboxId && (input.image !== undefined || input.network !== undefined))
        throw new Error("Image and network cannot change when reusing a sandbox.");
      const timeoutMs = input.timeoutMs ?? this.options.timeoutMs;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > this.options.maxTimeoutMs
      )
        throw new Error(`timeoutMs must be between 1 and ${this.options.maxTimeoutMs}.`);
      const workdir = input.workdir ?? ".";
      if (
        isAbsolute(workdir) ||
        workdir.includes("\0") ||
        posix.normalize(workdir).startsWith("../") ||
        posix.normalize(workdir) === ".."
      )
        throw new Error("workdir must be relative to /workspace, without escaping it.");
      const lifetime = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]);
      lifetime.throwIfAborted();
      const root = await realpath(source);
      const sandbox = input.sandboxId
        ? this.#get(owner, input.sandboxId)
        : await this.#create(owner, root, input, lifetime);
      if (sandbox.source !== root)
        throw new Error("Sandbox belongs to a different project directory.");
      sandbox.busy = true;
      let keep = input.keep ?? Boolean(input.sandboxId);
      try {
        const result = await this.#podman(
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
        if (result.timedOut || result.aborted) keep = false;
        let diff: ReturnType<typeof workspaceDiff> | undefined;
        let inspectionError: string | undefined;
        if (!result.timedOut && !result.aborted) {
          try {
            diff = workspaceDiff(
              sandbox.baseline,
              await scanWorkspace(sandbox.workspace, this.options, lifetime),
              this.options.maxOutputBytes,
            );
          } catch (error) {
            inspectionError = String(error);
          }
        }
        // Cancellation can arrive after exec exits, while files are being inspected.
        const aborted = result.aborted || lifetime.aborted;
        if (aborted) keep = false;
        return {
          ...result,
          aborted,
          sandboxId: keep ? sandbox.id : null,
          retained: keep,
          image: sandbox.image,
          network: sandbox.network,
          diff,
          inspectionError,
          omittedFromSnapshot: sandbox.baseline.omitted.slice(0, 100),
          omittedFromSnapshotCount: sandbox.baseline.omitted.length,
          note: "The command ran in a disposable copy. No changes have been applied to the source project. Diffs cover /workspace only, not installed system packages or external services.",
        };
      } catch (error) {
        keep = false;
        throw error;
      } finally {
        try {
          if (!keep) await this.#destroy(sandbox);
        } finally {
          sandbox.busy = false;
        }
      }
    });
  }

  inspect(owner: string, id: string, path?: string, signal?: AbortSignal) {
    return this.#track(async () => {
      const sandbox = this.#get(owner, id);
      sandbox.busy = true;
      try {
        const lifetime = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]);
        lifetime.throwIfAborted();
        if (path !== undefined) {
          const target = await safePath(sandbox.workspace, path);
          if (!(await lstat(target)).isFile())
            throw new Error("Only regular files can be read. Symlinks are not followed.");
          const size = (await lstat(target)).size;
          if (size > this.options.maxOutputBytes)
            throw new Error(
              `File exceeds ${this.options.maxOutputBytes} bytes. Inspect a smaller artifact inside the container.`,
            );
          const content = await readBounded(target, this.options.maxOutputBytes);
          if (content.includes(0))
            throw new Error("File is binary. Inspect it with a command inside the container.");
          return { sandboxId: id, path, content: content.toString("utf8") };
        }
        return {
          sandboxId: id,
          ...workspaceDiff(
            sandbox.baseline,
            await scanWorkspace(sandbox.workspace, this.options, lifetime),
            this.options.maxOutputBytes,
          ),
        };
      } finally {
        sandbox.busy = false;
      }
    });
  }

  remove(owner: string, id: string) {
    return this.#track(async () => {
      const sandbox = this.#get(owner, id);
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
    this.#lifetime.abort();
    await Promise.allSettled([...this.#operations]);
    const results = await Promise.allSettled(
      [...this.#sandboxes.values()].map((sandbox) => this.#destroy(sandbox)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Some sandbox resources could not be removed. Use podman ps -a --filter label=io.github.thisdevdane.opencode-podman-sandbox=true to inspect leftovers.",
      );
  }
}
