import assert from "node:assert/strict";
import { test } from "node:test";

import { runProcess, succeeded, type ProcessResult } from "../process.ts";

test("does not interpret arguments in a host shell", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "console.log(process.argv[1])",
    "$(printf should-not-expand)",
  ]);
  assert.equal(result.stdout, "$(printf should-not-expand)\n");
  assert.equal(result.exitCode, 0);
});

test("preserves command failures and caps combined output", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('x'.repeat(10000)); process.stderr.write('oops'); process.exitCode=7",
    ],
    { maxOutputBytes: 100 },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.byteLength(result.stdout + result.stderr), 100);
  assert.equal(result.truncated, true);
});

test("terminates timed-out commands", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

test("cancellation stops commands and pre-aborted work never starts", async () => {
  const controller = new AbortController();
  const operation = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await operation).aborted, true);
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal }),
    /abort/i,
  );
});

test("reports missing executables", async () => {
  await assert.rejects(runProcess("/not/an/installed/program", []), /Could not start/);
});

test("checks process success and preserves failure details", () => {
  const success: ProcessResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
  };
  assert.equal(succeeded(success, "Experiment"), success);

  const failures: { result: Partial<ProcessResult>; message: string }[] = [
    { result: { exitCode: 7 }, message: "Experiment failed: exit 7" },
    { result: { exitCode: null }, message: "Experiment failed: exit null" },
    {
      result: { exitCode: 1, stdout: "output", stderr: "error" },
      message: "Experiment failed: error",
    },
    { result: { exitCode: 1, stdout: "output" }, message: "Experiment failed: output" },
    { result: { timedOut: true }, message: "Experiment failed (timed out): exit 0" },
    { result: { aborted: true }, message: "Experiment failed (cancelled): exit 0" },
    {
      result: { timedOut: true, aborted: true },
      message: "Experiment failed (timed out): exit 0",
    },
  ];
  for (const { result, message } of failures) {
    assert.throws(() => succeeded({ ...success, ...result }, "Experiment"), { message });
  }
});
