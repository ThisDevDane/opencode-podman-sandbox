import assert from "node:assert/strict";
import { test } from "node:test";

import { hasErrorCode } from "../errors.ts";

test("matches filesystem error codes without assuming every thrown value is an Error", () => {
  const error = Object.assign(new Error("Missing file"), { code: "ENOENT" });
  assert.equal(hasErrorCode(error, "ENOENT"), true);
  assert.equal(hasErrorCode(error, "EACCES", "EPERM"), false);
  assert.equal(hasErrorCode({ code: "EPERM" }, "EACCES", "EPERM"), true);
  for (const value of [null, undefined, "ENOENT", new Error("ENOENT"), { code: 42 }]) {
    assert.equal(hasErrorCode(value, "ENOENT"), false);
  }
});
