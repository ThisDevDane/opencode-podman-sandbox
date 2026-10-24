import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runProcess, type ProcessOptions, type ProcessResult, type Runner } from "../process.ts";
import { SandboxManager } from "../sandbox.ts";

interface Call {
  executable: string;
  args: string[];
  options?: ProcessOptions;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

class FakeRunner {
  readonly calls: Call[] = [];
  exec?: (call: Call) => ProcessResult | Promise<ProcessResult>;
  create?: (call: Call) => ProcessResult | Promise<ProcessResult>;
  failStart = false;
  removeFailures = 0;

  readonly run: Runner = async (executable, args, options) => {
    const call = { executable, args, options };
    this.calls.push(call);
    if (executable === "git") {
      return runProcess(executable, args, options);
    }

    assert.equal(args[0], "--remote=false");
    switch (args[1]) {
      case "info":
        return result({
          stdout: JSON.stringify({
            host: { security: { rootless: true } },
            version: { Version: "6.1.0" },
          }),
        });
      case "create":
        return this.create ? this.create(call) : result({ stdout: "container-id\n" });
      case "start":
        return this.failStart ? result({ exitCode: 125, stderr: "start failed" }) : result();
      case "exec":
        return this.exec ? this.exec(call) : result();
      case "rm":
        if (this.removeFailures > 0) {
          this.removeFailures--;
          return result({ exitCode: 1, stderr: "removal failed" });
        }
        return result();
      case "unshare":
        return result();
      default:
        throw new Error(`Unexpected Podman invocation: ${args.join(" ")}`);
    }
  };

  podmanCalls(command?: string): Call[] {
    return this.calls.filter(
      (call) => call.executable === "podman" && (!command || call.args[1] === command),
    );
  }
}

async function fixture(t: TestContext, git = false): Promise<string> {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/sandbox-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "project");
  await mkdir(source);
  await writeFile(join(source, "tracked.txt"), "clean\n");
  if (git) {
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    assert.equal((await runProcess("git", ["init", "--quiet", source])).exitCode, 0);
    assert.equal((await runProcess("git", ["-C", source, "add", "."])).exitCode, 0);
    await writeFile(join(source, "tracked.txt"), "dirty\n");
    await writeFile(join(source, "untracked.txt"), "untracked\n");
    await writeFile(join(source, "ignored.txt"), "ignored\n");
  }
  return source;
}

function managerFor(
  t: TestContext,
  fake: FakeRunner,
  options: Record<string, unknown> = {},
): SandboxManager {
  const manager = new SandboxManager(options, fake.run);
  t.after(() => manager.dispose());
  return manager;
}

function createdWorkspace(fake: FakeRunner): string {
  const create = fake.podmanCalls("create")[0];
  assert.ok(create);
  const index = create.args.indexOf("--volume");
  assert.notEqual(index, -1);
  const mount = create.args[index + 1];
  assert.ok(mount?.endsWith(":/workspace:rw,Z"));
  return mount.slice(0, -":/workspace:rw,Z".length);
}

function assertForceRemoved(fake: FakeRunner): void {
  const removal = fake.podmanCalls("rm").at(-1);
  assert.ok(removal);
  assert.deepEqual(removal.args.slice(1, -1), [
    "rm",
    "--force",
    "--time=0",
    "--volumes",
    "--ignore",
  ]);
  assert.match(removal.args.at(-1)!, /^opencode-sandbox-/);
}

test("cancellation after exec completes still destroys a retained sandbox", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const manager = managerFor(t, fake);
  const controller = new AbortController();
  fake.exec = () => {
    controller.abort();
    return result();
  };
  const run = await manager.run(
    "session-a",
    source,
    { command: "true", keep: true },
    controller.signal,
  );
  assert.equal(run.aborted, true);
  assert.equal(run.retained, false);
  assertForceRemoved(fake);
  assert.deepEqual(manager.list("session-a"), []);
});

test("creates a rootless local container with only the private copied workspace mounted", async (t) => {
  const source = await fixture(t, true);
  const fake = new FakeRunner();
  let workspace = "";
  fake.exec = async () => {
    workspace = createdWorkspace(fake);
    assert.equal(await readFile(join(workspace, "tracked.txt"), "utf8"), "dirty\n");
    assert.equal(await readFile(join(workspace, "untracked.txt"), "utf8"), "untracked\n");
    await assert.rejects(access(join(workspace, "ignored.txt")));
    await writeFile(join(workspace, "experiment.txt"), "container only\n");
    return result({ exitCode: 0 });
  };
  const manager = managerFor(t, fake, { memory: "768m", cpus: 3, pidsLimit: 123 });

  const run = await manager.run("session-a", source, { command: "do experiment" });

  assert.equal(run.exitCode, 0);
  assert.equal(run.retained, false);
  const create = fake.podmanCalls("create")[0];
  assert.ok(create);
  assert.deepEqual(create.args.slice(0, 3), ["--remote=false", "create", "--name"]);
  for (const flag of [
    "--network",
    "none",
    "--http-proxy=false",
    "--image-volume=ignore",
    "--user",
    "0:0",
    "--security-opt",
    "no-new-privileges",
  ]) {
    assert.ok(create.args.includes(flag), `missing ${flag}`);
  }
  assert.equal(create.args[create.args.indexOf("--memory") + 1], "768m");
  assert.equal(create.args[create.args.indexOf("--cpus") + 1], "3");
  assert.equal(create.args[create.args.indexOf("--pids-limit") + 1], "123");
  assert.ok(!create.args.includes(source), "the real checkout must never be mounted");
  assert.notEqual(workspace, source);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "dirty\n");
  await assert.rejects(access(join(source, "experiment.txt")));
  assert.equal(
    run.diff?.changes.some(
      (change) => change.path === "experiment.txt" && change.status === "added",
    ),
    true,
  );
  assertForceRemoved(fake);
  assert.deepEqual(manager.list("session-a"), []);
});

test("uses fallbackImage only when a new sandbox has no explicit image", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const fallbackImage = "docker.io/library/python:3.14";
  const selectedImage = "docker.io/library/node:24";
  const manager = managerFor(t, fake, { fallbackImage });
  const fallback = await manager.run("session-a", source, { command: "true" });
  const selected = await manager.run("session-a", source, {
    command: "true",
    image: selectedImage,
  });
  assert.equal(fallback.image, fallbackImage);
  assert.equal(selected.image, selectedImage);
  assert.ok(fake.podmanCalls("create")[0]?.args.includes(fallbackImage));
  assert.ok(fake.podmanCalls("create")[1]?.args.includes(selectedImage));
});

test("returns a nonzero command exit code as a normal result and cleans a one-shot sandbox", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  fake.exec = () => result({ exitCode: 23, stdout: "partial output", stderr: "failed assertion" });
  const manager = managerFor(t, fake);

  const run = await manager.run("session-a", source, { command: "exit 23" });

  assert.equal(run.exitCode, 23);
  assert.equal(run.stdout, "partial output");
  assert.equal(run.stderr, "failed assertion");
  assert.equal(run.sandboxId, null);
  assert.equal(run.retained, false);
  assertForceRemoved(fake);
  assert.deepEqual(manager.list("session-a"), []);
});

test("retains installed state and workspace changes when the same session reuses a sandbox", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  let installed = false;
  let executions = 0;
  fake.exec = async (call) => {
    executions++;
    const command = call.args.at(-1);
    if (command === "install package") {
      installed = true;
      await writeFile(join(createdWorkspace(fake), "installed-state.txt"), "ready\n");
      return result({ stdout: "installed" });
    }
    assert.equal(command, "check package");
    return installed ? result({ stdout: "still installed" }) : result({ exitCode: 1 });
  };
  const manager = managerFor(t, fake);

  const first = await manager.run("session-a", source, { command: "install package", keep: true });
  assert.ok(first.sandboxId);
  const second = await manager.run("session-a", source, {
    command: "check package",
    sandboxId: first.sandboxId,
  });

  assert.equal(second.sandboxId, first.sandboxId);
  assert.equal(second.retained, true);
  assert.equal(second.stdout, "still installed");
  assert.equal(executions, 2);
  assert.equal(fake.podmanCalls("create").length, 1);
  assert.equal(fake.podmanCalls("start").length, 1);
  assert.equal(
    await readFile(join(createdWorkspace(fake), "installed-state.txt"), "utf8"),
    "ready\n",
  );
  assert.equal(manager.list("session-a").length, 1);
});

test("does not expose a retained sandbox to another session", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const manager = managerFor(t, fake);
  const first = await manager.run("session-a", source, { command: "true", keep: true });
  assert.ok(first.sandboxId);

  await assert.rejects(
    manager.run("session-b", source, { command: "true", sandboxId: first.sandboxId }),
    /Sandbox not found in this session/,
  );
  assert.deepEqual(manager.list("session-b"), []);
  assert.equal(manager.list("session-a")[0]?.sandboxId, first.sandboxId);
});

test("rejects concurrent reuse while a retained sandbox is busy", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const manager = managerFor(t, fake);
  const first = await manager.run("session-a", source, { command: "true", keep: true });
  assert.ok(first.sandboxId);
  const entered = deferred();
  const release = deferred();
  let executions = 0;
  fake.exec = async () => {
    executions++;
    entered.resolve();
    await release.promise;
    return result();
  };

  const running = manager.run("session-a", source, { command: "long", sandboxId: first.sandboxId });
  await entered.promise;
  await assert.rejects(
    manager.run("session-a", source, { command: "concurrent", sandboxId: first.sandboxId }),
    /Sandbox is busy/,
  );
  release.resolve();
  await running;
  assert.equal(executions, 1);
});

test("counts in-flight creations toward capacity", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const entered = deferred();
  const release = deferred();
  fake.create = async () => {
    entered.resolve();
    await release.promise;
    return result({ stdout: "container-id" });
  };
  const manager = managerFor(t, fake, { maxSandboxes: 1 });

  const creating = manager.run("session-a", source, { command: "first" });
  await entered.promise;
  await assert.rejects(
    manager.run("session-a", source, { command: "second" }),
    /Sandbox limit reached/,
  );
  release.resolve();
  await creating;
  assert.equal(fake.podmanCalls("create").length, 1);
});

test(
  "reserves capacity while preparing a workspace, before a container exists",
  { timeout: 5000 },
  async (t) => {
    const source = await fixture(t);
    const fake = new FakeRunner();
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const runner: Runner = async (executable, args, options) => {
      if (args[1] === "info") {
        entered.resolve();
        await release.promise;
      }
      return fake.run(executable, args, options);
    };
    const manager = new SandboxManager({ maxSandboxes: 1 }, runner);
    t.after(() => manager.dispose());

    const preparing = manager.run("session-a", source, { command: "first" });
    await entered.promise;
    assert.equal(fake.podmanCalls("create").length, 0);
    await assert.rejects(
      manager.run("session-a", source, { command: "second" }),
      /Sandbox limit reached/,
    );
    release.resolve();
    await preparing;
  },
);

test("a failed engine check releases its creation reservation", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  let failEngineCheck = true;
  const runner: Runner = async (executable, args, options) => {
    if (args[1] === "info" && failEngineCheck) {
      return result({ exitCode: 125, stderr: "engine unavailable" });
    }
    return fake.run(executable, args, options);
  };
  const manager = new SandboxManager({ maxSandboxes: 1 }, runner);
  t.after(() => manager.dispose());

  await assert.rejects(
    manager.run("session-a", source, { command: "first" }),
    /engine unavailable/,
  );
  assert.deepEqual(manager.list("session-a"), []);
  failEngineCheck = false;
  assert.equal((await manager.run("session-a", source, { command: "retry" })).exitCode, 0);
});

test("a failed snapshot releases its creation reservation", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const manager = managerFor(t, fake, { maxSandboxes: 1, maxSnapshotBytes: 1 });

  await assert.rejects(manager.run("session-a", source, { command: "first" }), /Snapshot exceeds/);
  assert.deepEqual(manager.list("session-a"), []);
  assert.equal(fake.podmanCalls("create").length, 0);
  await writeFile(join(source, "tracked.txt"), "");
  assert.equal((await manager.run("session-a", source, { command: "retry" })).exitCode, 0);
});

for (const step of ["create", "start"] as const) {
  test(`cleans the container and private workspace when ${step} fails`, async (t) => {
    const source = await fixture(t);
    const fake = new FakeRunner();
    if (step === "create") {
      fake.create = () => result({ exitCode: 125, stderr: "create failed" });
    } else {
      fake.failStart = true;
    }
    const manager = managerFor(t, fake);

    await assert.rejects(
      manager.run("session-a", source, { command: "true" }),
      new RegExp(`${step === "create" ? "Creating" : "Starting"} sandbox container`),
    );

    assertForceRemoved(fake);
    assert.deepEqual(manager.list("session-a"), []);
    const workspace = createdWorkspace(fake);
    await assert.rejects(access(workspace));
    assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "clean\n");
  });
}

test("destroys the whole container when the command times out", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  fake.exec = () => result({ exitCode: null, timedOut: true, stderr: "killed" });
  const manager = managerFor(t, fake);

  const run = await manager.run("session-a", source, {
    command: "sleep forever",
    keep: true,
    timeoutMs: 10,
  });

  assert.equal(run.timedOut, true);
  assert.equal(run.retained, false);
  assert.equal(run.sandboxId, null);
  assert.equal(fake.podmanCalls("exec")[0]?.options?.timeoutMs, 10);
  assertForceRemoved(fake);
  assert.deepEqual(manager.list("session-a"), []);
});

test("cancellation returns an aborted result and force-removes the container", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const entered = deferred();
  fake.exec = (call) => {
    entered.resolve();
    return new Promise((resolve) => {
      const signal = call.options?.signal;
      assert.ok(signal);
      if (signal.aborted) {
        resolve(result({ exitCode: null, aborted: true }));
      } else {
        signal.addEventListener("abort", () => resolve(result({ exitCode: null, aborted: true })), {
          once: true,
        });
      }
    });
  };
  const manager = managerFor(t, fake);
  const controller = new AbortController();

  const running = manager.run(
    "session-a",
    source,
    { command: "sleep forever", keep: true },
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  const run = await running;

  assert.equal(run.aborted, true);
  assert.equal(run.retained, false);
  assert.equal(run.sandboxId, null);
  assertForceRemoved(fake);
  assert.deepEqual(manager.list("session-a"), []);
});

test("surfaces cleanup failure and allows a later remove to retry it", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  fake.removeFailures = 1;
  const manager = managerFor(t, fake);

  await assert.rejects(manager.run("session-a", source, { command: "true" }), /Removing container/);
  const retained = manager.list("session-a");
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.busy, false);

  assert.deepEqual(await manager.remove("session-a", retained[0]!.sandboxId), {
    removed: retained[0]!.sandboxId,
  });
  assert.deepEqual(manager.list("session-a"), []);
  assert.equal(fake.podmanCalls("rm").length, 2);
});

test("dispose waits for active execution and cleans every remaining sandbox", async (t) => {
  const source = await fixture(t);
  const fake = new FakeRunner();
  const manager = managerFor(t, fake);
  const retained = await manager.run("session-a", source, { command: "true", keep: true });
  assert.ok(retained.sandboxId);
  const entered = deferred();
  const aborted = deferred();
  const release = deferred();
  fake.exec = (call) => {
    entered.resolve();
    return new Promise((resolve) => {
      const signal = call.options?.signal;
      assert.ok(signal);
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          void release.promise.then(() => resolve(result({ exitCode: null, aborted: true })));
        },
        { once: true },
      );
    });
  };

  const running = manager.run("session-a", source, {
    command: "long",
    sandboxId: retained.sandboxId,
  });
  await entered.promise;
  let disposed = false;
  const disposing = manager.dispose().then(() => {
    disposed = true;
  });
  await aborted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, "dispose must wait for the aborted exec to finish");
  release.resolve();
  await running;
  await disposing;

  assert.deepEqual(manager.list("session-a"), []);
  assertForceRemoved(fake);
});
