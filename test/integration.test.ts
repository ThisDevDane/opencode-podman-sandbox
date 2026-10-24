import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxManager } from "../sandbox.ts";

test(
  "real rootless Podman isolates files, retains state, and cleans up",
  { skip: process.env.PODMAN_SANDBOX_INTEGRATION !== "1", timeout: 180_000 },
  async (t) => {
    await mkdir("/tmp/opencode", { recursive: true });
    const root = await mkdtemp("/tmp/opencode/sandbox-integration-");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "source.txt"), "original\n");
    await writeFile(join(source, ".env"), "EXPERIMENT_SECRET=do-not-copy\n");
    const manager = new SandboxManager({
      podman: process.env.PODMAN_SANDBOX_EXECUTABLE ?? "podman",
    });
    t.after(async () => {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await manager.status()).rootless, true);
    const first = await manager.run("integration", source, {
      command:
        "test ! -e .env && printf 'changed\\n' > source.txt && printf 'artifact\\n' > result.txt && printf 'persisted\\n' > /root/installed-state.txt && id -u",
      keep: true,
    });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /^0\n$/);
    assert.equal(first.diff?.changeCount, 2);
    assert.equal(await readFile(join(source, "source.txt"), "utf8"), "original\n");
    const second = await manager.run("integration", source, {
      sandboxId: first.sandboxId!,
      command:
        "cat /root/installed-state.txt result.txt && cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max",
    });
    assert.equal(second.stdout, "persisted\nartifact\n1073741824\n200000 100000\n256\n");
    const inspected = await manager.inspect("integration", first.sandboxId!, "result.txt");
    assert.equal("content" in inspected ? inspected.content : undefined, "artifact\n");
    await manager.remove("integration", first.sandboxId!);
    assert.deepEqual(manager.list("integration"), []);
    const timed = await manager.run("integration", source, {
      command: "sleep 30",
      keep: true,
      timeoutMs: 100,
    });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.retained, false);
    assert.deepEqual(manager.list("integration"), []);
    const locked = await manager.run("integration", source, {
      command: "mkdir locked && touch locked/file && chown -R 1234:1234 locked && chmod 700 locked",
    });
    assert.equal(locked.exitCode, 0, locked.stderr);
    assert.match(locked.inspectionError ?? "", /EACCES|permission denied/i);
    assert.deepEqual(manager.list("integration"), []);
  },
);

test(
  "real rootless networking supports a disposable package install",
  {
    skip: process.env.PODMAN_SANDBOX_NETWORK_INTEGRATION !== "1",
    timeout: 180_000,
  },
  async (t) => {
    await mkdir("/tmp/opencode", { recursive: true });
    const source = await mkdtemp("/tmp/opencode/sandbox-network-integration-");
    const manager = new SandboxManager({
      podman: process.env.PODMAN_SANDBOX_EXECUTABLE ?? "podman",
    });
    t.after(async () => {
      await manager.dispose();
      await rm(source, { recursive: true, force: true });
    });
    const installed = await manager.run("network-integration", source, {
      command: "apt-get update -qq && apt-get install -y -qq jq && jq --version",
      network: "pasta",
      keep: true,
    });
    assert.equal(installed.exitCode, 0, installed.stderr);
    assert.match(installed.stdout, /jq-1\./);
    const reused = await manager.run("network-integration", source, {
      sandboxId: installed.sandboxId!,
      command: "jq -n '2 + 2'",
      keep: false,
    });
    assert.equal(reused.stdout, "4\n");
    assert.equal(reused.retained, false);
    assert.deepEqual(manager.list("network-integration"), []);
  },
);
