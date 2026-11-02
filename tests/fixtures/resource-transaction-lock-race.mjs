import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withResourceTransactionLock } from "../../src/local/resource-transaction-lock.mjs";
import { currentProcessStartTimeMs } from "../../src/local/process-identity.mjs";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "mbm-resource-lock-race-"));
  const file = join(root, "transaction.lock");
  const owner = { token: "a".repeat(32), pid: process.pid, purpose: "resource-coordinator",
    startedAt: new Date().toISOString(), processStartedAt: new Date(currentProcessStartTimeMs()).toISOString() };
  fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
  return { root, file, owner };
}

async function withStatInterleaving(file, interleave, run) {
  const original = fs.lstatSync;
  let observations = 0;
  fs.lstatSync = function (target, ...args) {
    const info = original.call(this, target, ...args);
    if (target === file) interleave(++observations, info);
    return info;
  };
  syncBuiltinESMExports();
  try { return await run(); }
  finally { fs.lstatSync = original; syncBuiltinESMExports(); }
}

export async function runResourceTransactionLockRaceScenarios() {
  await test("released transaction lock between inspection and read is reacquired exclusively", async () => {
    const { root, file, owner } = fixture();
    let released = false;
    let entered = 0;
    try {
      await withStatInterleaving(file, (observation) => {
        if (observation === 1) {
          fs.unlinkSync(file);
          released = true;
        }
      }, () => withResourceTransactionLock(root, () => {
        entered += 1;
        const current = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(current.pid, process.pid);
        assert.notEqual(current.token, owner.token);
      }, { timeoutMs: 1000 }));
      assert.equal(released, true);
      assert.equal(entered, 1);
      assert.equal(fs.existsSync(file), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  for (const code of ["EACCES", "EIO"]) {
    await test("transaction owner read preserves " + code, async () => {
      const { root, file, owner } = fixture();
      let entered = false;
      try {
        await withStatInterleaving(file, (observation) => {
          if (observation === 2) throw Object.assign(new Error("synthetic owner read failure"), { code });
        }, () => assert.rejects(() => withResourceTransactionLock(root, () => {
          entered = true;
        }, { timeoutMs: 1000 }), (error) => error.code === code || error.cause?.code === code));
        assert.equal(entered, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), owner);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  await test("repeated disappearing observations respect the transaction deadline", async () => {
    const { root, file, owner } = fixture();
    let entered = false;
    try {
      await withStatInterleaving(file, (observation) => {
        if (observation % 2 === 0) throw Object.assign(new Error("synthetic released generation"), { code: "ENOENT" });
      }, () => assert.rejects(() => withResourceTransactionLock(root, () => {
        entered = true;
      }, { timeoutMs: 25 }), (error) => error.code === "MBM_RESOURCE_TRANSACTION_BUSY"));
      assert.equal(entered, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), owner);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
