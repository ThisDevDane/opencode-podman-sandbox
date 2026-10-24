import assert from "node:assert/strict";
import { test } from "node:test";
import { imageReference, sandboxOptions } from "../config.ts";

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
