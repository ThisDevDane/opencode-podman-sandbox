# Podman on Debian 13

This project uses rootless Podman. The installer uses AlviStack's community OBS apt repository for Podman and its required newer container packages; it does not build Podman from source. The repository is third-party software, not an official Debian or Podman repository.

The installer is optional. Do not use it until you have chosen to trust AlviStack. Its packaging is active, but the related Podman Ansible role lists one GitHub contributor; a large maintainer base or apt user count has not been established. The project does not require Homebrew.

As verified on 2026-10-24, the repository's signed Debian 13 amd64 index offered Podman `100:6.1.3-1` (upstream 6.1.3; upstream 6.1.4 was newer). Its published signing-key fingerprint is `789C FFDE 0295 B8A1 F4E5 690C 4BEC C975 50D0 B1FD`. The installer checks that fingerprint and the signed `InRelease`, uses an isolated apt index and package simulation, and asks apt to confirm before installing. Its apt pin allows only the container packages needed from AlviStack and gives every other package in that repository priority `-1`. Rootless helpers `uidmap`, `fuse-overlayfs`, and `passt` are taken from Debian stable. It does not run a full system upgrade or remove packages.

[Upstream supports the newest release](https://github.com/podman-container-tools/podman#readme), currently the 6.1 series. Debian's older version can have separate distribution security patches; that is not the same support promise. This setup targets 6.1 and does not install Debian's 5.4.2 engine. The community package can lag upstream patch releases, so check `apt-cache policy podman` and the upstream release notes before installing or upgrading.

From the repository root, run:

```sh
sudo bash scripts/install-podman-debian.sh
```

The command prompts for your sudo password, prints the simulated package transaction, then asks before installing. On success it leaves its own signed-by keyring, apt source, and package pin in `/usr/share/keyrings` and `/etc/apt`. It does not change subuid/subgid ranges, sysctls, sudo policy, start a daemon, or enable a socket. Review the third-party repository and package list before accepting.

Run these checks as your normal user, not with `sudo`:

```sh
podman info --format '{{.Host.Security.Rootless}}'
grep "^$(id -un):" /etc/subuid /etc/subgid
podman unshare cat /proc/self/uid_map
podman run --rm quay.io/podman/hello
```

The first command should print `true`; the subuid and subgid files should contain a range for your user. The final command pulls and runs a small test image.

## Per-user storage paths

On the development host, the packaged default selected root-owned paths under `/var/lib/containers/storage` and `/run/containers/storage` even when invoked as the normal user. An explicit per-user `~/.config/containers/storage.conf` fixed that:

```toml
[storage]
driver = "overlay"
runroot = "/run/user/1001/containers"
graphroot = "/home/agent/.local/share/containers/storage"
```

Those paths are specific to the development account. Use your own UID and home directory on another machine. Check existing configuration before adding an override. Do not delete an existing container database or use `podman system reset` to fix path selection.

The plugin does not need a Podman API socket or daemon. Use `podman --remote=false info` to verify the local engine. Resource limits also require rootless cgroup controller delegation; the integration test checks memory, CPU, and process limits inside an actual container.
