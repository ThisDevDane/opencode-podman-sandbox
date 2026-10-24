import assert from "node:assert/strict";
import { test } from "node:test";

import { imageReference, runSettings, sandboxOptions, type RunInput } from "../config.ts";

test("defaults use a qualified image and bounded resources", () => {
  const options = sandboxOptions();
  assert.equal(options.fallbackImage, "docker.io/library/debian:trixie-slim");
  assert.equal(options.timeoutMs, 120_000);
  assert.equal(options.memory, "1g");
  assert.equal(options.maxSandboxes, 4);
});

test("rejects unknown settings and invalid limits", () => {
  for (const input of [
    { privileged: true },
    { cpus: 0 },
    { timeoutMs: 100, maxTimeoutMs: 50 },
    { memory: "0g" },
    { podman: "podman --remote" },
    { maxOutputBytes: Infinity },
  ]) {
    assert.throws(() => sandboxOptions(input));
  }
  assert.equal(sandboxOptions({ maxTimeoutMs: 100 }).timeoutMs, 100);
  assert.equal(sandboxOptions({ podman: "/usr/bin/podman" }).podman, "/usr/bin/podman");
});

test("image names cannot become host command options", () => {
  for (const value of [
    "alpine",
    "--privileged",
    "docker.io/library/alpine;id",
    "docker.io/library/alpine\n",
    "docker.io/library/alpine $(id)",
  ]) {
    assert.throws(() => imageReference(value));
  }
  assert.equal(imageReference("quay.io/podman/hello:latest"), "quay.io/podman/hello:latest");
  assert.equal(
    imageReference("localhost:5000/team/image@sha256:abc123"),
    "localhost:5000/team/image@sha256:abc123",
  );
});

test("fallbackImage is configurable without renaming the per-run image argument", () => {
  assert.equal(
    sandboxOptions({ fallbackImage: "docker.io/library/node:24" }).fallbackImage,
    "docker.io/library/node:24",
  );
  assert.throws(() => sandboxOptions({ fallbackImage: "node:24" }), /fully qualified/);
  assert.throws(
    () => sandboxOptions({ image: "docker.io/library/node:24" }),
    /Unknown sandbox option: image/,
  );
});

test("run settings keep defaults separate from explicit per-call choices", () => {
  const options = sandboxOptions();
  assert.deepEqual(runSettings({ command: "true" }, options), {
    timeoutMs: options.timeoutMs,
    workdir: ".",
  });
  assert.deepEqual(runSettings({ command: "true", workdir: "src", timeoutMs: 50 }, options), {
    timeoutMs: 50,
    workdir: "src",
  });
});

test("rejects invalid commands, networking, and changes to retained sandbox settings", () => {
  const options = sandboxOptions();
  for (const command of ["", " ", "true\0false"]) {
    assert.throws(() => runSettings({ command }, options), /non-empty shell command/);
  }
  const invalidNetwork = { command: "true", network: "host" } as unknown as RunInput;
  assert.throws(() => runSettings(invalidNetwork, options), /network must be none or pasta/);
  assert.throws(
    () =>
      runSettings(
        { command: "true", sandboxId: "existing", image: options.fallbackImage },
        options,
      ),
    /cannot change/,
  );
  assert.throws(
    () => runSettings({ command: "true", sandboxId: "existing", network: "none" }, options),
    /cannot change/,
  );
});

test("rejects unsafe working directories and out-of-range run timeouts", () => {
  const options = sandboxOptions();
  for (const workdir of ["/tmp", "..", "../outside", "src/../../outside", "bad\0path"]) {
    assert.throws(
      () => runSettings({ command: "true", workdir }, options),
      /workdir must be relative/,
    );
  }
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, options.maxTimeoutMs + 1]) {
    assert.throws(
      () => runSettings({ command: "true", timeoutMs }, options),
      /timeoutMs must be between/,
    );
  }
});
