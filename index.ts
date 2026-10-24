import { realpath } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { SandboxManager, type RunInput } from "./sandbox.ts";
import { inside } from "./workspace.ts";

const string = { type: "string" } as const;
const sandboxIdInput = {
  type: "object",
  properties: { sandboxId: string },
  required: ["sandboxId"],
  additionalProperties: false,
} as const;
const output = (value: unknown) => ({ content: JSON.stringify(value, null, 2) });

export async function register(
  plugin: Plugin.Context,
  manager = new SandboxManager(plugin.options),
) {
  const checkout = await realpath(plugin.location.project.directory);
  async function permission(
    context: ToolContext,
    action: string,
    resources: string[],
    metadata: Record<string, unknown> = {},
  ) {
    await plugin.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources,
      metadata,
    });
  }

  await plugin.tool.transform((editor) => {
    editor.namespace({
      name: "sandbox",
      description:
        "Try commands in disposable rootless Podman containers without modifying the live project. Use sandbox.run for installers, dependency experiments and checks. This is an experiment environment, not a security boundary.",
    });
    editor.add({
      name: "run",
      options: { namespace: "sandbox", codemode: true },
      description: `Run a /bin/sh command against a disposable copy of this session's project, including uncommitted and non-ignored untracked files. Never edits the source project. Choose an image matching the project and command for each new sandbox. Only when image is omitted does the plugin use its configured fallbackImage, currently ${manager.options.fallbackImage}. Networking defaults to none. Set keep=true to retain the container and reuse its returned sandboxId. Reuse preserves installed packages and files. New shell on each call. Retained sandboxes are session-owned and removed when the plugin unloads. Use network=pasta only when the user permits Internet access; external effects cannot be rolled back. Common secret files and dependency/cache directories are omitted, but this is not comprehensive secret scanning. No host environment or credentials are explicitly forwarded.`,
      input: {
        type: "object",
        properties: {
          command: {
            ...string,
            description: "Shell command executed inside the container, never on the host.",
          },
          sandboxId: {
            ...string,
            description:
              "Reuse a retained sandbox from this session. Do not also pass image or network.",
          },
          keep: {
            type: "boolean",
            description:
              "Retain a new sandbox. Defaults false for new sandboxes, true when reusing one.",
          },
          image: {
            ...string,
            description:
              "Choose a fully qualified OCI image matching the project and command. New sandboxes only. If omitted, the plugin uses its configured fallbackImage.",
          },
          network: {
            type: "string",
            enum: ["none", "pasta"],
            description: "New sandbox only. Default none. pasta enables rootless networking.",
          },
          workdir: {
            ...string,
            description: "Directory relative to the copied project, default '.' .",
          },
          timeoutMs: { type: "integer", minimum: 1, maximum: manager.options.maxTimeoutMs },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(value, context) {
        const input = value as RunInput;
        const session = await plugin.session.get({ sessionID: context.sessionID });
        const source = await realpath(session.location.directory);
        if (!inside(checkout, source))
          throw new Error(
            "Session has moved outside this plugin's checkout. Reload the plugin at the new location.",
          );
        const retained = input.sandboxId
          ? manager.list(context.sessionID).find((item) => item.sandboxId === input.sandboxId)
          : undefined;
        const image = retained?.image ?? input.image ?? manager.options.fallbackImage;
        const network = retained?.network ?? input.network ?? "none";
        await permission(context, "sandbox.run", [input.command], {
          image,
          network,
          source,
          sandboxId: input.sandboxId,
        });
        if (network === "pasta")
          await permission(context, "sandbox.network", [image], { network: "pasta" });
        await context.progress({ title: "Running in a disposable Podman sandbox" });
        return output(await manager.run(context.sessionID, source, input, context.signal));
      },
    });
    editor.add({
      name: "inspect",
      options: { namespace: "sandbox", codemode: true },
      description:
        "Inspect changes in a retained sandbox, or read one relative text file. Returns review-only diffs against the original snapshot. Does not apply changes or follow file symlinks.",
      input: {
        ...sandboxIdInput,
        properties: {
          sandboxId: string,
          path: {
            ...string,
            description: "Optional relative text file path. Omit to get the workspace diff.",
          },
        },
      },
      async execute(value, context) {
        const input = value as { sandboxId: string; path?: string };
        await permission(context, "sandbox.inspect", [input.sandboxId]);
        return output(
          await manager.inspect(context.sessionID, input.sandboxId, input.path, context.signal),
        );
      },
    });
    editor.add({
      name: "list",
      options: { namespace: "sandbox", codemode: true },
      description:
        "List retained sandboxes owned by this session. Does not start Podman or list other users' containers.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_value, context) {
        return output(manager.list(context.sessionID));
      },
    });
    editor.add({
      name: "remove",
      options: { namespace: "sandbox", codemode: true },
      description:
        "Discard a retained sandbox and its files. Never removes source project files or unrelated Podman resources.",
      input: sandboxIdInput,
      async execute(value, context) {
        const { sandboxId } = value as { sandboxId: string };
        await permission(context, "sandbox.remove", [sandboxId]);
        return output(await manager.remove(context.sessionID, sandboxId));
      },
    });
    editor.add({
      name: "status",
      options: { namespace: "sandbox", codemode: true },
      description:
        "Check whether the local Podman engine is available and rootless. Does not pull images or create containers.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_value, context) {
        return output(await manager.status(context.signal));
      },
    });
  });
  return () => manager.dispose();
}

export default Plugin.define({
  id: "opencode-podman-sandbox",
  setup: (plugin) => register(plugin),
});
