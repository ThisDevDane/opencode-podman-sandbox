import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcess } from "../process.ts";

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
