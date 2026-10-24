# opencode-podman-sandbox

An OpenCode V2 plugin for trying commands in disposable rootless Podman containers before changing your real project or installing tools on your host.

The plugin copies the calling session's project, runs the experiment in a container, and returns stdout, stderr, the exit code, and workspace diffs. It never applies changes back. Retain a sandbox when several commands need the same installed packages and files.

This is a test environment for trusted commands and images, not a security boundary for hostile code. Containers share the host kernel. Results also depend on the chosen image, which may differ from your host.

## Requirements

- Linux with a local, working rootless Podman engine. Use the current upstream-supported release, presently Podman 6.1. A remote-only client is not sufficient.
- OpenCode V2 with the `@opencode/plugin` 2.1 API.
- Git on the host for project file selection.
- An image containing `/bin/sh` and `sleep`. The agent can choose a suitable image per experiment; `docker.io/library/debian:trixie-slim` is only the fallback when it does not specify one.

See [Podman setup](docs/podman-setup.md) for the optional Debian 13 community apt installer and its maintenance/trust tradeoffs. Installing the plugin does not install Podman, change system configuration, or enable a socket.

## Load the plugin

Clone the repository, install its dependencies with `mise install` and `pnpm install --frozen-lockfile`, then add its absolute directory to your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/workspaces/opencode-podman-sandbox",
      "options": {
        "fallbackImage": "docker.io/library/debian:trixie-slim",
      },
    },
  ],
}
```

Merge this into existing configuration rather than replacing unrelated settings. The package exports TypeScript source, matching OpenCode's local-plugin loading support. It is not published to npm yet.

The `options` object is optional. `fallbackImage` is used only when the agent omits the per-run `image` argument. The agent should normally choose an image matching the project and command, and that choice overrides the fallback for the new sandbox. Retained sandboxes keep their original image.

## Tools

The tools use the `sandbox` namespace. OpenCode can expose them as `sandbox.run`, `sandbox.inspect`, `sandbox.list`, `sandbox.remove`, and `sandbox.status`. The corresponding flat tool IDs are `sandbox_run`, `sandbox_inspect`, `sandbox_list`, `sandbox_remove`, and `sandbox_status`.

### Run once

Give `sandbox.run` this input:

```json
{
  "command": "sh scripts/check.sh",
  "timeoutMs": 120000
}
```

The plugin removes the container and temporary workspace after collecting results, even when the command exits nonzero. A failed command's exit code is returned as data. Provisioning and cleanup failures are tool errors.

Images are pulled if missing, so creating even a `network: "none"` sandbox can contact an image registry. The network setting controls the experiment container, not the host's image pull.

### Keep state between commands

To try an installer without installing packages on the host:

```json
{
  "command": "apt-get update && apt-get install -y jq && jq --version",
  "network": "pasta",
  "keep": true
}
```

This requires approval for networking under the configured OpenCode permission rules. Reuse the returned ID:

```json
{
  "sandboxId": "ID returned by the first call",
  "command": "jq --version"
}
```

Reusing a sandbox retains it by default. Set `keep: false` to discard it after that command. Image and network settings are fixed at creation. Every call starts a new shell, so shell variables and `cd` do not persist. Use the relative `workdir` argument to select a copied subdirectory.

Experiments run as root inside the rootless container so package installers work. That container root maps to your normal host user, not host root.

### Inspect and discard

- `sandbox.inspect` with `{ "sandboxId": "ID" }` returns cumulative file changes against the original snapshot.
- Add `"path": "relative/result.txt"` to read a small text artifact instead. It never follows a final file symlink.
- `sandbox.list` with `{}` lists retained sandboxes belonging to the current session.
- `sandbox.remove` with `{ "sandboxId": "ID" }` discards one sandbox and its files.
- `sandbox.status` with `{}` checks the local engine and requires it to report rootless mode.

There is no apply, merge, push, or host-execution tool. Review the results before making real changes through your normal workflow.

## What gets copied

For Git projects, the snapshot uses tracked files as they currently exist on disk, plus non-ignored untracked files. It includes uncommitted edits and does not commit, stash, or otherwise change the source repository. A subdirectory session copies that subdirectory, not the whole parent repository. Non-Git directories are also supported.

The snapshot excludes Git metadata, dependency/cache directories such as `node_modules` and `.venv`, and common credential files such as `.env`, `.env.*`, `.npmrc`, `.netrc`, `*.pem`, and `*.key`. `.env.example`, `.env.sample`, and `.env.template` are allowed. Relative symlinks are copied only when they do not resolve outside the source project; absolute links are omitted. Special files are omitted.

These rules are not comprehensive secret scanning. Review the project before granting networking. Images and your Podman configuration are also trusted inputs. The plugin does not explicitly forward host credentials, proxy variables, or your home directory.

Only a private temporary copy is mounted read-write, never the source checkout. There are no configurable extra host mounts, host network mode, or privileged-container options.

## Limits and cleanup

Default limits are 1 GiB container memory, 2 CPUs, 256 processes, four sandboxes, and a 120-second command timeout. The maximum permitted timeout is 600 seconds. Containers need working rootless cgroups for resource limits.

Snapshots are limited to 10,000 files and 100 MiB. Oversized source snapshots fail rather than quietly running an incomplete project. Directory traversal is bounded too. Diff inspection uses the same limits and reports omitted data instead of claiming a complete result. Dependency/cache directories remain excluded during inspection. Binary files and files larger than 32 KiB get metadata-only changes. Patch previews are capped at 64 KiB and change lists at 200 entries. These are review previews, not guaranteed complete or minimal patches.

Stdout and stderr share a 64 KiB output limit. `truncated`, `inspectionError`, and omitted-file fields indicate incomplete results. Diffs cover `/workspace` only, not installed system packages or changes elsewhere in the container.

Timeouts and cancellation remove the entire container, including retained sandboxes, because stopping a `podman exec` client alone can leave commands running. Concurrent operations on one sandbox are rejected. Retained sandboxes belong to their creating session and are removed when the plugin unloads. They are not restored after an OpenCode restart. Remove them explicitly when done; deleting a session alone does not currently trigger cleanup.

An abrupt service kill can leave containers and temporary directories. Inspect labelled leftovers with:

```sh
podman ps --all --filter label=io.github.thisdevdane.opencode-podman-sandbox=true
```

Remove only a confirmed leftover by its exact name with `podman rm --force --volumes CONTAINER_NAME`. Cleanup errors name retained resources rather than silently reporting success. The plugin never runs a global prune. Container images and Podman caches can remain on the host. The temporary workspace is not a disk quota, so large experiments can still consume host disk space.

Networking is off by default. When enabled, external service changes cannot be rolled back by removing the container.

## Configuration

| Option             | Default                                | Meaning                                                |
| ------------------ | -------------------------------------- | ------------------------------------------------------ |
| `podman`           | `podman`                               | Executable name or absolute path to the local engine   |
| `fallbackImage`    | `docker.io/library/debian:trixie-slim` | Image used only when a new run omits `image`           |
| `timeoutMs`        | `120000`                               | Default command timeout                                |
| `maxTimeoutMs`     | `600000`                               | Maximum command/provisioning timeout, at most one hour |
| `maxOutputBytes`   | `65536`                                | Combined command output and patch-preview budget       |
| `maxSnapshotBytes` | `104857600`                            | Source copy and diff-inspection byte budget            |
| `maxSnapshotFiles` | `10000`                                | Source copy and diff-inspection file budget            |
| `maxSandboxes`     | `4`                                    | Active and provisioning sandbox limit                  |
| `memory`           | `1g`                                   | Container memory limit                                 |
| `cpus`             | `2`                                    | Container CPU limit                                    |
| `pidsLimit`        | `256`                                  | Container process limit                                |

The plugin uses OpenCode permission actions `sandbox.run`, `sandbox.network`, `sandbox.inspect`, and `sandbox.remove`. For example, to ask before commands and networking:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "sandbox.run", "resource": "*", "effect": "ask" },
    { "action": "sandbox.network", "resource": "*", "effect": "ask" },
  ],
}
```

`sandbox.run` uses the command as its permission resource; `sandbox.network` uses the image. Network permission is checked again when a network-enabled sandbox is reused. Permission denial propagates through OpenCode rather than becoming a successful tool result.

## Development

The toolchain follows `opencode-rider-hooks`: Node 24, pnpm 12.14.0, strict erasable TypeScript, and native `node:test`. Oxlint handles linting and Oxfmt handles formatting.

```sh
mise install
pnpm install --frozen-lockfile
pnpm check
```

The default suite uses temporary fixtures and a fake Podman runner for lifecycle tests. To run the real engine test after rootless setup:

```sh
PODMAN_SANDBOX_INTEGRATION=1 pnpm test
```

Set `PODMAN_SANDBOX_EXECUTABLE=/absolute/path/to/podman` if necessary. The real test pulls the fallback image and verifies isolation, retained state, inspection, resource limits, timeout cleanup, and explicit removal. Passing mocked tests is not a substitute for this check.

An additional opt-in test enables rootless networking, installs `jq` inside the disposable container, then verifies that the installation survives a second command:

```sh
PODMAN_SANDBOX_INTEGRATION=1 PODMAN_SANDBOX_NETWORK_INTEGRATION=1 pnpm test
```
