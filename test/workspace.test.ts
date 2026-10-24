import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sandboxOptions } from "../config.ts";
import { runProcess, succeeded } from "../process.ts";
import { excluded, safePath, scanWorkspace, snapshotProject, workspaceDiff } from "../workspace.ts";

async function fixture(t: TestContext) {
  await mkdir("/tmp/opencode", { recursive: true });
  const directory = await mkdtemp("/tmp/opencode/sandbox-workspace-test-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const copy = join(directory, "copy");
  await mkdir(source);
  return { directory, source, copy };
}

test("copies dirty tracked files and untracked files, omitting ignored files and secrets", async (t) => {
  const { source, copy } = await fixture(t);
  succeeded(await runProcess("git", ["init", source]), "fixture init");
  await writeFile(join(source, "tracked.txt"), "original\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  succeeded(
    await runProcess("git", ["-C", source, "add", "tracked.txt", ".gitignore"]),
    "fixture staging",
  );
  await writeFile(join(source, "tracked.txt"), "uncommitted\n");
  await writeFile(join(source, "untracked.txt"), "new\n");
  await writeFile(join(source, "ignored.txt"), "ignored\n");
  await writeFile(join(source, ".env"), "SECRET=not-for-container\n");
  await writeFile(join(source, ".env.example"), "SECRET=\n");
  const result = await snapshotProject(source, copy, sandboxOptions());
  assert.equal(await readFile(join(copy, "tracked.txt"), "utf8"), "uncommitted\n");
  assert.equal(await readFile(join(copy, "untracked.txt"), "utf8"), "new\n");
  assert.equal(result.files.has("ignored.txt"), false);
  assert.equal(result.files.has(".env"), false);
  assert.equal(result.files.has(".env.example"), true);
  await assert.rejects(lstat(join(copy, ".git")), /ENOENT/);
  await writeFile(join(copy, "tracked.txt"), "changed in sandbox\n");
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "uncommitted\n");
});

test("non-Git snapshots omit dependency folders and external symlinks", async (t) => {
  const { source, copy, directory } = await fixture(t);
  await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "node_modules", "module.js"), "module");
  await writeFile(join(source, "script.sh"), "#!/bin/sh\n");
  await chmod(join(source, "script.sh"), 0o755);
  await writeFile(join(directory, "external.txt"), "outside");
  await symlink("script.sh", join(source, "internal-link"));
  await symlink("../external.txt", join(source, "external-link"));
  await symlink(join(source, "script.sh"), join(source, "absolute-link"));
  const result = await snapshotProject(source, copy, sandboxOptions());
  assert.deepEqual([...result.files.keys()], ["internal-link", "script.sh"]);
  assert.equal((await lstat(join(copy, "script.sh"))).mode & 0o111, 0o111);
  assert.equal((await lstat(join(copy, "internal-link"))).isSymbolicLink(), true);
});

test("refuses paths escaping the workspace, including symlink ancestors", async (t) => {
  const { source, directory } = await fixture(t);
  await symlink(directory, join(source, "escape"));
  for (const name of ["../outside", "/etc/passwd", "escape/file", "\0bad"]) {
    await assert.rejects(safePath(source, name));
  }
});

test("snapshot limits fail instead of silently creating an incomplete project", async (t) => {
  const { source, copy } = await fixture(t);
  await writeFile(join(source, "a"), "12345");
  await writeFile(join(source, "b"), "67890");
  await assert.rejects(
    snapshotProject(source, copy, sandboxOptions({ maxSnapshotBytes: 5 })),
    /exceeds/,
  );
  await assert.rejects(
    snapshotProject(source, join(copy, "files"), sandboxOptions({ maxSnapshotFiles: 1 })),
    /exceeds/,
  );
});

test("ignored entries do not consume the selected-file limit", async (t) => {
  const { source, copy } = await fixture(t);
  await writeFile(join(source, "a.txt"), "selected\n");
  await writeFile(join(source, ".env"), "ignored\n");
  const result = await snapshotProject(source, copy, sandboxOptions({ maxSnapshotFiles: 1 }));
  assert.deepEqual([...result.files.keys()], ["a.txt"]);
});

test("diffs include additions, deletions, executable bits, links, and missing final newlines", async (t) => {
  const { source, copy, directory } = await fixture(t);
  await writeFile(join(source, "modified.txt"), "old");
  await writeFile(join(source, "deleted.txt"), "gone\n");
  await writeFile(join(source, "empty.txt"), "");
  await writeFile(join(source, "script.sh"), "echo test\n");
  const before = await snapshotProject(source, copy, sandboxOptions());
  await writeFile(join(copy, "modified.txt"), "new\n");
  await rm(join(copy, "deleted.txt"));
  await rm(join(copy, "empty.txt"));
  await writeFile(join(copy, "added with spaces.txt"), "added\n");
  await writeFile(join(copy, "empty-added.txt"), "");
  await chmod(join(copy, "script.sh"), 0o755);
  await symlink("script.sh", join(copy, "link"));
  const result = workspaceDiff(before, await scanWorkspace(copy, sandboxOptions()));
  assert.equal(result.changes.length, 7);
  assert.equal(result.truncated, false);
  assert.match(result.patch, /No newline at end of file/);
  assert.match(result.patch, /new mode 100755/);
  const patch = join(directory, "changes.patch");
  await writeFile(patch, result.patch);
  const check = await runProcess("git", ["-C", source, "apply", "--check", patch]);
  assert.equal(check.exitCode, 0, check.stderr + result.patch);
});

test("diff inspection never follows a generated link to host data", async (t) => {
  const { source, copy } = await fixture(t);
  await writeFile(join(source, "a"), "before\n");
  const before = await snapshotProject(source, copy, sandboxOptions());
  await symlink("/etc", join(copy, "host-link"));
  const after = await scanWorkspace(copy, sandboxOptions());
  assert.equal(after.files.get("host-link")?.text, "/etc");
  assert.equal(
    [...after.files.keys()].some((path) => path.includes("passwd")),
    false,
  );
  const result = workspaceDiff(before, after, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.patch, "");
});

test("excluded paths cover secret files in subdirectories", () => {
  for (const path of [
    ".env",
    "nested/.env.local",
    "nested/.npmrc",
    ".ssh/config",
    "key.pem",
    "key.key",
    "node_modules/x",
  ])
    assert.equal(excluded(path), true, path);
  assert.equal(excluded(".env.example"), false);
  assert.equal(excluded("src/index.ts"), false);
});

test("an unrelated oversized file does not hide confirmed deletions", async (t) => {
  const { source, copy } = await fixture(t);
  await writeFile(join(source, "deleted.txt"), "original\n");
  await writeFile(join(source, "kept.txt"), "kept\n");
  const before = await snapshotProject(source, copy, sandboxOptions());
  await rm(join(copy, "deleted.txt"));
  await writeFile(join(copy, "oversized.bin"), Buffer.alloc(1000));
  const after = await scanWorkspace(copy, sandboxOptions({ maxSnapshotBytes: 100 }));
  const diff = workspaceDiff(before, after);
  assert.equal(diff.truncated, true);
  assert.equal(diff.changeCount, 1);
  assert.deepEqual(
    diff.changes.map((change) => [change.path, change.status]),
    [["deleted.txt", "deleted"]],
  );
});

test("a file omitted from content inspection is not reported as deleted", async (t) => {
  const { source, copy } = await fixture(t);
  await writeFile(join(source, "grown.txt"), "small\n");
  const before = await snapshotProject(source, copy, sandboxOptions());
  await writeFile(join(copy, "grown.txt"), "x".repeat(1000));
  const diff = workspaceDiff(
    before,
    await scanWorkspace(copy, sandboxOptions({ maxSnapshotBytes: 100 })),
  );
  assert.equal(diff.truncated, true);
  assert.deepEqual(diff.changes, []);
});
