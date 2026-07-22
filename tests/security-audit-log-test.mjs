import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecurityAuditLog } from "../src/local/security-audit-log.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-"));
let now = Date.UTC(2026, 6, 21, 0, 0, 0);
try {
  const audit = new SecurityAuditLog({ root, now: () => now });
  const principal = {
    kind: "account",
    accountId: `acct_${"a".repeat(32)}`,
    accountVersion: 3,
    clientId: `mcp_client_${"b".repeat(43)}`,
    familyId: `mcp_family_${"c".repeat(43)}`,
    role: "owner",
  };
  assert(await audit.record({
    outcome: "completed",
    tool: "read_file",
    riskCategory: "credential-sensitive read",
    targetHash: "d".repeat(64),
    principal,
    durationMs: 12.8,
    inputBytes: 100,
    outputBytes: 200,
  }), "security audit event was not recorded");
  now += 1000;
  assert(await audit.record({
    outcome: "failed",
    tool: "exec_command",
    riskCategory: "remote shell or process control",
    principal,
    durationMs: 20,
    errorCode: "execution_failed",
  }), "second security audit event was not recorded");

  const snapshot = audit.snapshot();
  assert(snapshot.enabled && snapshot.healthy && snapshot.chain_verified && snapshot.retained === 2, "security audit snapshot did not verify its chain");
  const file = path.join(root, "security-audit.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert(!JSON.stringify(state).includes(principal.accountId), "security audit persisted the raw account id");
  assert(!JSON.stringify(state).includes(principal.clientId), "security audit persisted the raw client id");
  assert(!JSON.stringify(state).includes(principal.familyId), "security audit persisted the raw token family id");
  assert(!JSON.stringify(state).includes("credential contents"), "security audit persisted operation content");
  assert(state.events[1].previous_hash === state.events[0].hash, "security audit chain did not link adjacent events");

  const concurrentA = new SecurityAuditLog({ root, now: () => now });
  const concurrentB = new SecurityAuditLog({ root, now: () => now });
  const concurrentResults = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? concurrentA : concurrentB).record({
    outcome: "completed", tool: `concurrent_${index}`, principal, durationMs: index,
  })));
  assert(concurrentResults.every(Boolean), "cross-instance security audit write failed");
  const concurrentState = JSON.parse(readFileSync(file, "utf8"));
  assert(concurrentState.events.length === 22, "cross-instance security audit writes lost events");
  assert(concurrentState.events.every((event, index) => event.sequence === index + 1), "cross-instance security audit sequence is not continuous");
  assert(new SecurityAuditLog({ root, now: () => now }).snapshot().chain_verified, "cross-instance security audit chain did not verify");

  concurrentState.events[0].tool = "tampered";
  writeFileSync(file, `${JSON.stringify(concurrentState)}\n`, { mode: 0o600 });
  const tampered = new SecurityAuditLog({ root, now: () => now });
  assert(tampered.snapshot().healthy === false && tampered.snapshot().chain_verified === false, "security audit tampering was not detected");
  assert(await tampered.record({ outcome: "completed", tool: "server_info" }) === false, "tampered audit state was silently overwritten");

  console.log("security audit log test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
