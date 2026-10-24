import { spawn } from "node:child_process";

import { hasErrorCode } from "./errors.ts";

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
    let retainedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        // Detached children have their own process group. Stop their subprocesses too.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH")) {
          child.kill(signal);
        }
      }
    };
    const stopChild = () => {
      killProcessGroup("SIGTERM");
      forceKillTimer ??= setTimeout(() => killProcessGroup("SIGKILL"), 1000);
      forceKillTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stopChild();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, options.timeoutMs ?? 120_000);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
    const collectOutput = (chunks: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, limit - retainedBytes);
      if (chunk.length > remaining) {
        truncated = true;
      }
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
      }
      retainedBytes += Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", collectOutput(stdout));
    child.stderr.on("data", collectOutput(stderr));
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
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
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
    return result;
  }

  let reason = "";
  if (result.timedOut) {
    reason = " (timed out)";
  } else if (result.aborted) {
    reason = " (cancelled)";
  }
  const details = result.stderr || result.stdout || `exit ${result.exitCode}`;
  throw new Error(`${action} failed${reason}: ${details}`);
}
