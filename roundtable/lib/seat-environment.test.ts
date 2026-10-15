import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSourceHost, resolveMachine, seatEnvironment } from "./seat-environment.ts";

test("a room with a workspace reuses it, whatever its machine", () => {
  assert.deepEqual(
    seatEnvironment({ environmentId: "env_1", hostId: "host_a" }, { gitRemoteUrl: "git@x:y.git" }),
    { type: "reuse", environmentId: "env_1" },
  );
});

test("a room pinned to a machine spawns there: a worktree for a git project", () => {
  assert.deepEqual(
    seatEnvironment({ environmentId: null, hostId: "host_spark" }, { gitRemoteUrl: "git@github.com:ai-dynamo/dynamo.git" }),
    { type: "host", hostId: "host_spark", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
  );
});

test("a room pinned to a machine spawns there: the checkout for a non-git project", () => {
  assert.deepEqual(
    seatEnvironment({ environmentId: null, hostId: "host_spark" }, { gitRemoteUrl: null }),
    { type: "host", hostId: "host_spark", workspace: { type: "unmanaged", path: null } },
  );
});

test("a room with neither keeps bb's project default", () => {
  assert.deepEqual(seatEnvironment({ environmentId: null, hostId: null }, { gitRemoteUrl: null }), { type: "project-default" });
});

test("the default source's machine wins; otherwise the first source; otherwise none", () => {
  assert.equal(defaultSourceHost([{ hostId: "a", isDefault: false }, { hostId: "b", isDefault: true }]), "b");
  assert.equal(defaultSourceHost([{ hostId: "a", isDefault: false }]), "a");
  assert.equal(defaultSourceHost([]), null);
});

const hosts = [
  { id: "host_rydt6w8d4j", name: "spark-p" },
  { id: "host_29rqi9c258", name: "brev-x86-cpu" },
  { id: "host_x1", name: "dup" },
  { id: "host_x2", name: "dup" },
];

test("a machine resolves by exact id or unambiguous name", () => {
  assert.equal(resolveMachine("host_rydt6w8d4j", hosts), "host_rydt6w8d4j");
  assert.equal(resolveMachine("spark-p", hosts), "host_rydt6w8d4j");
});

test("an unknown or ambiguous machine is an error, not a guess", () => {
  assert.throws(() => resolveMachine("nope", hosts), /unknown machine "nope"/);
  assert.throws(() => resolveMachine("dup", hosts), /ambiguous/);
});
