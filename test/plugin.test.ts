import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";

import { register } from "../index.ts";
import type { RunInput, SandboxManager } from "../sandbox.ts";

interface PermissionRequest {
  sessionID: string;
  agent: string;
  action: string;
  resources: string[];
  metadata?: Record<string, unknown>;
  source: { type: string; messageID: string; id: string };
}

interface ToolDefinition {
  name: string;
  description: string;
  input: { properties?: Record<string, { description?: string }>; required?: readonly string[] };
  options: { namespace: string; codemode: boolean };
  execute: (input: unknown, context: ToolContext) => Promise<{ content: string }>;
}

class FakeManager {
  readonly options = {
    fallbackImage: "docker.io/library/debian:trixie-slim",
    maxTimeoutMs: 600_000,
  };
  readonly runs: Array<{ owner: string; source: string; input: RunInput; signal?: AbortSignal }> =
    [];
  readonly inspected: Array<{ owner: string; id: string; path?: string }> = [];
  readonly removed: Array<{ owner: string; id: string }> = [];
  disposeCalls = 0;
  retained?: { image: string; network: "none" | "pasta" };
  events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async run(owner: string, source: string, input: RunInput, signal?: AbortSignal) {
    this.events.push("manager.run");
    this.runs.push({ owner, source, input, signal });
    return { sandboxId: "sandbox-1", retained: true };
  }

  async inspect(owner: string, id: string, path?: string) {
    this.events.push("manager.inspect");
    this.inspected.push({ owner, id, path });
    return { sandboxId: id, path, content: "contents" };
  }

  list(owner: string) {
    this.events.push("manager.list");
    return [{ sandboxId: `${owner}-sandbox`, ...this.retained }];
  }

  async remove(owner: string, id: string) {
    this.events.push("manager.remove");
    this.removed.push({ owner, id });
    return { removed: id };
  }

  async status() {
    this.events.push("manager.status");
    return { rootless: true, version: "6.1.0", activeSandboxes: 0 };
  }

  async dispose() {
    this.events.push("manager.dispose");
    this.disposeCalls++;
  }
}

interface Setup {
  tools: Map<string, ToolDefinition>;
  namespaces: Array<{ name: string; description: string }>;
  permissions: PermissionRequest[];
  events: string[];
  checkout: string;
  outside: string;
  cleanup: () => Promise<void>;
}

async function setupPlugin(
  t: TestContext,
  options: { manager?: FakeManager; sessionDirectory?: string; denyAction?: string } = {},
): Promise<Setup> {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/plugin-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  const nested = join(checkout, "nested");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  const events: string[] = [];
  const manager = options.manager ?? new FakeManager(events);
  manager.events = events;
  const tools = new Map<string, ToolDefinition>();
  const namespaces: Array<{ name: string; description: string }> = [];
  const permissions: PermissionRequest[] = [];
  const plugin = {
    options: {},
    location: { project: { directory: checkout } },
    session: {
      get: async () => ({ location: { directory: options.sessionDirectory ?? nested } }),
    },
    permission: {
      assert: async (request: PermissionRequest) => {
        permissions.push(request);
        events.push(`permission:${request.action}`);
        if (request.action === options.denyAction) {
          throw new Error(`Denied ${request.action}`);
        }
      },
    },
    tool: {
      transform: async (
        transform: (editor: {
          namespace: (value: { name: string; description: string }) => void;
          add: (tool: ToolDefinition) => void;
        }) => void,
      ) => {
        transform({
          namespace: (value) => namespaces.push(value),
          add: (tool) => tools.set(tool.name, tool),
        });
      },
    },
  } as unknown as Plugin.Context;

  const cleanup = await register(plugin, manager as unknown as SandboxManager);
  return {
    tools,
    namespaces,
    permissions,
    events,
    checkout: await realpath(checkout),
    outside,
    cleanup,
  };
}

function context(events: string[]): ToolContext {
  return {
    sessionID: "session-a",
    agent: "agent-a",
    messageID: "message-a",
    id: "call-a",
    signal: new AbortController().signal,
    progress: async () => {
      events.push("progress");
    },
  } as unknown as ToolContext;
}

function tool(setup: Setup, name: string): ToolDefinition {
  const definition = setup.tools.get(name);
  assert.ok(definition, `missing tool ${name}`);
  return definition;
}

function content(value: { content: string }): unknown {
  return JSON.parse(value.content);
}

test("registers the sandbox namespace and all five tools", async (t) => {
  const setup = await setupPlugin(t);

  assert.deepEqual(
    setup.namespaces.map((value) => value.name),
    ["sandbox"],
  );
  assert.deepEqual([...setup.tools.keys()].sort(), ["inspect", "list", "remove", "run", "status"]);
  for (const definition of setup.tools.values()) {
    assert.deepEqual(definition.options, { namespace: "sandbox", codemode: true });
  }
  await setup.cleanup();
});

test("advertises agent image selection and the configured fallback", async (t) => {
  const manager = new FakeManager();
  manager.options.fallbackImage = "docker.io/library/python:3.14";
  const setup = await setupPlugin(t, { manager });
  const run = tool(setup, "run");
  assert.match(
    run.description,
    /Choose an image matching the project and command for each new sandbox/,
  );
  assert.ok(
    run.description.includes(
      `Only when image is omitted does the plugin use its configured fallbackImage, currently ${manager.options.fallbackImage}`,
    ),
  );
  assert.match(run.input.properties?.image?.description ?? "", /If omitted.*fallbackImage/);
  assert.equal(run.input.required?.includes("image"), false);
  await setup.cleanup();
});

test("asserts run permission before execution and requests separate pasta network permission", async (t) => {
  const setup = await setupPlugin(t);
  const events = setup.events;

  const response = await tool(setup, "run").execute(
    { command: "curl https://example.com", network: "pasta" },
    context(events),
  );

  assert.deepEqual(events, [
    "permission:sandbox.run",
    "permission:sandbox.network",
    "progress",
    "manager.run",
  ]);
  assert.deepEqual(
    setup.permissions.map((request) => request.action),
    ["sandbox.run", "sandbox.network"],
  );
  assert.deepEqual(setup.permissions[0]?.resources, ["curl https://example.com"]);
  assert.deepEqual(setup.permissions[1]?.resources, ["docker.io/library/debian:trixie-slim"]);
  assert.deepEqual(setup.permissions[1]?.metadata, { network: "pasta" });
  assert.deepEqual(content(response), { sandboxId: "sandbox-1", retained: true });
  assert.equal(setup.permissions[0]?.sessionID, "session-a");
  assert.equal(setup.permissions[0]?.agent, "agent-a");
  assert.deepEqual(setup.permissions[0]?.source, {
    type: "tool",
    messageID: "message-a",
    id: "call-a",
  });
  await setup.cleanup();
});

test("does not execute when run permission is denied", async (t) => {
  const manager = new FakeManager();
  const setup = await setupPlugin(t, { manager, denyAction: "sandbox.run" });

  await assert.rejects(
    tool(setup, "run").execute({ command: "true" }, context(setup.events)),
    /Denied sandbox.run/,
  );
  assert.equal(manager.runs.length, 0);
  assert.deepEqual(setup.events, ["permission:sandbox.run"]);
  await setup.cleanup();
});

test("does not execute a networked run when network permission is denied", async (t) => {
  const manager = new FakeManager();
  const setup = await setupPlugin(t, { manager, denyAction: "sandbox.network" });

  await assert.rejects(
    tool(setup, "run").execute({ command: "true", network: "pasta" }, context(setup.events)),
    /Denied sandbox.network/,
  );
  assert.equal(manager.runs.length, 0);
  assert.deepEqual(setup.events, ["permission:sandbox.run", "permission:sandbox.network"]);
  await setup.cleanup();
});

test("rechecks network permission when reusing a network-enabled sandbox", async (t) => {
  const manager = new FakeManager();
  manager.retained = { image: "docker.io/library/node:24", network: "pasta" };
  const setup = await setupPlugin(t, { manager, denyAction: "sandbox.network" });
  await assert.rejects(
    tool(setup, "run").execute(
      { command: "true", sandboxId: "session-a-sandbox" },
      context(setup.events),
    ),
    /Denied sandbox.network/,
  );
  assert.equal(manager.runs.length, 0);
  assert.deepEqual(
    setup.permissions.map((request) => request.action),
    ["sandbox.run", "sandbox.network"],
  );
  assert.deepEqual(setup.permissions[1]?.resources, [manager.retained.image]);
  await setup.cleanup();
});

test("asserts inspect and remove permissions before their operations", async (t) => {
  const manager = new FakeManager();
  const setup = await setupPlugin(t, { manager });

  await tool(setup, "inspect").execute(
    { sandboxId: "sandbox-1", path: "artifact.txt" },
    context(setup.events),
  );
  await tool(setup, "remove").execute({ sandboxId: "sandbox-1" }, context(setup.events));

  assert.deepEqual(setup.events, [
    "permission:sandbox.inspect",
    "manager.inspect",
    "permission:sandbox.remove",
    "manager.remove",
  ]);
  assert.deepEqual(
    setup.permissions.map((request) => [request.action, request.resources]),
    [
      ["sandbox.inspect", ["sandbox-1"]],
      ["sandbox.remove", ["sandbox-1"]],
    ],
  );
  assert.deepEqual(manager.inspected, [
    { owner: "session-a", id: "sandbox-1", path: "artifact.txt" },
  ]);
  assert.deepEqual(manager.removed, [{ owner: "session-a", id: "sandbox-1" }]);
  await setup.cleanup();
});

test("uses the calling session directory rather than the plugin location", async (t) => {
  const manager = new FakeManager();
  const setup = await setupPlugin(t, { manager });
  const ctx = context(setup.events);

  await tool(setup, "run").execute({ command: "pwd", keep: true }, ctx);

  assert.equal(manager.runs.length, 1);
  assert.equal(manager.runs[0]?.owner, "session-a");
  assert.equal(manager.runs[0]?.source, await realpath(join(setup.checkout, "nested")));
  assert.notEqual(manager.runs[0]?.source, setup.checkout);
  assert.equal(manager.runs[0]?.signal, ctx.signal);
  assert.equal(setup.permissions[0]?.metadata?.source, manager.runs[0]?.source);
  await setup.cleanup();
});

test("refuses a session outside the plugin checkout before permission or execution", async (t) => {
  const manager = new FakeManager();
  const initial = await setupPlugin(t, { manager });
  const setup = await setupPlugin(t, { manager, sessionDirectory: initial.outside });

  await assert.rejects(
    tool(setup, "run").execute({ command: "true" }, context(setup.events)),
    /outside this plugin's checkout/,
  );
  assert.equal(manager.runs.length, 0);
  assert.equal(setup.permissions.length, 0);
  assert.deepEqual(setup.events, []);
  await initial.cleanup();
  await setup.cleanup();
});

test("list and status execute without sandbox permissions and cleanup disposes the manager", async (t) => {
  const manager = new FakeManager();
  const setup = await setupPlugin(t, { manager });

  assert.deepEqual(content(await tool(setup, "list").execute({}, context(setup.events))), [
    { sandboxId: "session-a-sandbox" },
  ]);
  assert.deepEqual(content(await tool(setup, "status").execute({}, context(setup.events))), {
    rootless: true,
    version: "6.1.0",
    activeSandboxes: 0,
  });
  assert.deepEqual(setup.events, ["manager.list", "manager.status"]);
  assert.equal(setup.permissions.length, 0);

  await setup.cleanup();
  assert.equal(manager.disposeCalls, 1);
});
