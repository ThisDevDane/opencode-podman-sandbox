import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { sandboxOptions } from "../config.ts";
import { runProcess, succeeded } from "../process.ts";
import { excluded, safePath, scanWorkspace, snapshotProject, workspaceDiff } from "../workspace.ts";

async function createFixture(t: TestContext) {
  await mkdir("/tmp/opencode", { recursive: true });
  const directory = await mkdtemp("/tmp/opencode/sandbox-workspace-test-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "source");
  const sandbox = join(directory, "copy");
  await mkdir(project);
  return { directory, project, sandbox };
}

test("copies dirty tracked files and untracked files, omitting ignored files and secrets", async (t) => {
  const { project, sandbox } = await createFixture(t);
  succeeded(await runProcess("git", ["init", project]), "fixture init");
  await writeFile(join(project, "tracked.txt"), "original\n");
  await writeFile(join(project, ".gitignore"), "ignored.txt\n");
  succeeded(
    await runProcess("git", ["-C", project, "add", "tracked.txt", ".gitignore"]),
    "fixture staging",
  );
  await writeFile(join(project, "tracked.txt"), "uncommitted\n");
  await writeFile(join(project, "untracked.txt"), "new\n");
  await writeFile(join(project, "ignored.txt"), "ignored\n");
  await writeFile(join(project, ".env"), "SECRET=not-for-container\n");
  await writeFile(join(project, ".env.example"), "SECRET=\n");

  const snapshot = await snapshotProject(project, sandbox, sandboxOptions());

  assert.equal(await readFile(join(sandbox, "tracked.txt"), "utf8"), "uncommitted\n");
  assert.equal(await readFile(join(sandbox, "untracked.txt"), "utf8"), "new\n");
  assert.equal(snapshot.files.has("ignored.txt"), false);
  assert.equal(snapshot.files.has(".env"), false);
  assert.equal(snapshot.files.has(".env.example"), true);
  await assert.rejects(lstat(join(sandbox, ".git")), /ENOENT/);
  await writeFile(join(sandbox, "tracked.txt"), "changed in sandbox\n");
  assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "uncommitted\n");
});

test("non-Git snapshots omit dependency folders and external symlinks", async (t) => {
  const { directory, project, sandbox } = await createFixture(t);
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, "node_modules", "module.js"), "module");
  await writeFile(join(project, "script.sh"), "#!/bin/sh\n");
  await chmod(join(project, "script.sh"), 0o755);
  await writeFile(join(directory, "external.txt"), "outside");
  await symlink("script.sh", join(project, "internal-link"));
  await symlink("../external.txt", join(project, "external-link"));
  await symlink(join(project, "script.sh"), join(project, "absolute-link"));

  const snapshot = await snapshotProject(project, sandbox, sandboxOptions());

  assert.deepEqual([...snapshot.files.keys()], ["internal-link", "script.sh"]);
  assert.equal((await lstat(join(sandbox, "script.sh"))).mode & 0o111, 0o111);
  assert.equal((await lstat(join(sandbox, "internal-link"))).isSymbolicLink(), true);
});

test("refuses paths escaping the workspace, including symlink ancestors", async (t) => {
  const { directory, project } = await createFixture(t);
  await symlink(directory, join(project, "escape"));
  for (const name of ["../outside", "/etc/passwd", "escape/file", "\0bad"]) {
    await assert.rejects(safePath(project, name));
  }
});

test("snapshot limits fail instead of silently creating an incomplete project", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "a"), "12345");
  await writeFile(join(project, "b"), "67890");

  await assert.rejects(
    snapshotProject(project, sandbox, sandboxOptions({ maxSnapshotBytes: 5 })),
    /exceeds/,
  );
  await assert.rejects(
    snapshotProject(project, join(sandbox, "files"), sandboxOptions({ maxSnapshotFiles: 1 })),
    /exceeds/,
  );
});

test("ignored entries do not consume the selected-file limit", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "a.txt"), "selected\n");
  await writeFile(join(project, ".env"), "ignored\n");

  const snapshot = await snapshotProject(project, sandbox, sandboxOptions({ maxSnapshotFiles: 1 }));

  assert.deepEqual([...snapshot.files.keys()], ["a.txt"]);
});

test("diffs include additions, deletions, executable bits, links, and missing final newlines", async (t) => {
  const { directory, project, sandbox } = await createFixture(t);
  await writeFile(join(project, "modified.txt"), "old");
  await writeFile(join(project, "deleted.txt"), "gone\n");
  await writeFile(join(project, "empty.txt"), "");
  await writeFile(join(project, "script.sh"), "echo test\n");
  const before = await snapshotProject(project, sandbox, sandboxOptions());
  await writeFile(join(sandbox, "modified.txt"), "new\n");
  await rm(join(sandbox, "deleted.txt"));
  await rm(join(sandbox, "empty.txt"));
  await writeFile(join(sandbox, "added with spaces.txt"), "added\n");
  await writeFile(join(sandbox, "empty-added.txt"), "");
  await chmod(join(sandbox, "script.sh"), 0o755);
  await symlink("script.sh", join(sandbox, "link"));

  const diff = workspaceDiff(before, await scanWorkspace(sandbox, sandboxOptions()));

  assert.equal(diff.changes.length, 7);
  assert.equal(diff.truncated, false);
  assert.match(diff.patch, /No newline at end of file/);
  assert.match(diff.patch, /new mode 100755/);
  const patchPath = join(directory, "changes.patch");
  await writeFile(patchPath, diff.patch);
  const check = await runProcess("git", ["-C", project, "apply", "--check", patchPath]);
  assert.equal(check.exitCode, 0, check.stderr + diff.patch);
});

test("diff inspection never follows a generated link to host data", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "a"), "before\n");
  const before = await snapshotProject(project, sandbox, sandboxOptions());
  await symlink("/etc", join(sandbox, "host-link"));

  const after = await scanWorkspace(sandbox, sandboxOptions());

  assert.equal(after.files.get("host-link")?.text, "/etc");
  assert.equal(
    [...after.files.keys()].some((path) => path.includes("passwd")),
    false,
  );
  const diff = workspaceDiff(before, after, 1);
  assert.equal(diff.truncated, true);
  assert.equal(diff.patch, "");
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
  ]) {
    assert.equal(excluded(path), true, path);
  }
  assert.equal(excluded(".env.example"), false);
  assert.equal(excluded("src/index.ts"), false);
});

test("an unrelated oversized file does not hide confirmed deletions", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "deleted.txt"), "original\n");
  await writeFile(join(project, "kept.txt"), "kept\n");
  const before = await snapshotProject(project, sandbox, sandboxOptions());
  await rm(join(sandbox, "deleted.txt"));
  await writeFile(join(sandbox, "oversized.bin"), Buffer.alloc(1000));

  const after = await scanWorkspace(sandbox, sandboxOptions({ maxSnapshotBytes: 100 }));
  const diff = workspaceDiff(before, after);

  assert.equal(diff.truncated, true);
  assert.equal(diff.changeCount, 1);
  assert.deepEqual(
    diff.changes.map((change) => [change.path, change.status]),
    [["deleted.txt", "deleted"]],
  );
});

test("a file omitted from content inspection is not reported as deleted", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "grown.txt"), "small\n");
  const before = await snapshotProject(project, sandbox, sandboxOptions());
  await writeFile(join(sandbox, "grown.txt"), "x".repeat(1000));

  const diff = workspaceDiff(
    before,
    await scanWorkspace(sandbox, sandboxOptions({ maxSnapshotBytes: 100 })),
  );

  assert.equal(diff.truncated, true);
  assert.deepEqual(diff.changes, []);
});

test("binary and large files get metadata-only diffs", async (t) => {
  const { project, sandbox } = await createFixture(t);
  await writeFile(join(project, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(project, "large.txt"), "a".repeat(32_769));
  const before = await snapshotProject(project, sandbox, sandboxOptions());

  await writeFile(join(sandbox, "binary.dat"), Buffer.from([0, 1, 3]));
  await writeFile(join(sandbox, "large.txt"), "b".repeat(32_769));
  const diff = workspaceDiff(before, await scanWorkspace(sandbox, sandboxOptions()));

  assert.equal(diff.changeCount, 2);
  assert.equal(diff.patch.match(/Binary or large file changed; content omitted\./g)?.length, 2);
  assert.equal(diff.patch.includes("b".repeat(100)), false);
  assert.equal(diff.truncated, false);
});
