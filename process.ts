import { spawn } from "node:child_process";

export interface ProcessOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export type Runner = (
  executable: string,
  args: string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

// Never invoke a host shell. Only the container's /bin/sh interprets experiment commands.
export const runProcess: Runner = async (executable, args, options = {}) => {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const limit = options.maxOutputBytes ?? 65_536;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
      escalation.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 120_000);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, limit - bytes);
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`Could not start ${executable}: ${error.message}`, { cause: error }));
    });
    child.once("close", (exitCode) => {
      cleanup();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
        timedOut,
        aborted,
      });
    });
  });
};

export function succeeded(result: ProcessResult, action: string): ProcessResult {
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new Error(
      `${action} failed${result.timedOut ? " (timed out)" : result.aborted ? " (cancelled)" : ""}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}
