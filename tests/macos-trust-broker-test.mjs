import { appendFileSync, chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeviceIdentity } from "../src/local/device-identity.mjs";
import {
  buildDevelopmentTrustBrokerBinary,
  ensureMacosSecureDeviceRoot,
  inspectProvisionedMacosTrustBroker,
  probeProvisionedMacosTrustBroker,
  signWithMacosSecureDeviceRoot,
} from "../src/local/macos-trust-broker.mjs";

if (process.platform !== "darwin") {
  console.log("macOS trust broker test skipped on non-macOS");
  process.exit(0);
}

const root = mkdtempSync(path.join(tmpdir(), "mbm-trust-broker-"));
try {
  const binary = buildDevelopmentTrustBrokerBinary(root);
  const canonicalBinary = realpathSync(binary);
  const info = statSync(binary);
  assert(info.isFile(), "development trust broker build did not produce a regular file");
  assert((info.mode & 0o077) === 0, "development trust broker is accessible to group or other users");
  assert((info.mode & 0o700) === 0o700, "development trust broker is not owner-executable");

  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binary], { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 });
  assert(signature.status === 0, `development trust broker ad-hoc signature verification failed: ${signature.stderr}`);
  expectThrow(
    () => inspectProvisionedMacosTrustBroker(binary),
    "ad-hoc signing cannot access the data-protection Keychain",
  );

  const usage = spawnSync(binary, [], { encoding: "utf8", killSignal: "SIGKILL", timeout: 10_000 });
  assert(usage.status !== 0 && usage.stderr.includes("usage:"), "development trust broker did not fail closed on an invalid command");

  const second = buildDevelopmentTrustBrokerBinary(root);
  assert(second === binary, "development trust broker cache path changed without a source change");

  appendFileSync(binary, Buffer.from([0]));
  const rebuilt = buildDevelopmentTrustBrokerBinary(root);
  assert(rebuilt === binary, "tampered development trust broker was rebuilt at a different path");
  const rebuiltSignature = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binary], { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 });
  assert(rebuiltSignature.status === 0, "tampered development trust broker was not rebuilt and re-signed");

  chmodSync(binary, 0o777);
  expectThrow(
    () => buildDevelopmentTrustBrokerBinary(root),
    "must remain owner-only and owner-executable",
  );
  chmodSync(binary, 0o700);

  const marker = `${binary}.sha256`;
  const markerBytes = readFileSync(marker);
  unlinkSync(marker);
  symlinkSync(binary, marker);
  expectThrow(
    () => buildDevelopmentTrustBrokerBinary(root),
    "must not be a symbolic link",
  );
  unlinkSync(marker);
  writeFileSync(marker, markerBytes, { mode: 0o600 });

  const markerHardLink = `${marker}.link`;
  linkSync(marker, markerHardLink);
  expectThrow(
    () => buildDevelopmentTrustBrokerBinary(root),
    "must not have multiple hard links",
  );
  unlinkSync(markerHardLink);

  const binaryHardLink = `${binary}.link`;
  linkSync(binary, binaryHardLink);
  expectThrow(
    () => buildDevelopmentTrustBrokerBinary(root),
    "must not have multiple hard links",
  );
  unlinkSync(binaryHardLink);

  const publicJwk = createDeviceIdentity().publicJwk;
  const calls = [];
  const provisionedSpawn = (command, args, processOptions) => {
    assert(processOptions?.killSignal === "SIGKILL",
      "macOS trust broker bounded subprocess used a soft timeout signal");
    calls.push({ command, args: [...args], processOptions });
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return result(0, "", "");
    if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
      return result(0, "", [
        "Identifier=com.machine-bridge-mcp.trust-broker",
        "TeamIdentifier=ABCDEFGHIJ",
        "Signature=Apple Development: Test Identity",
      ].join("\n"));
    }
    if (command !== canonicalBinary) return result(1, "", "unexpected executable");
    const action = args[0];
    const tag = args[2];
    if (action === "ensure" || action === "public") {
      return jsonResult({
        ok: true,
        provider: "macos-secure-enclave-v1",
        keyTag: tag,
        publicJwk,
        signature: null,
        secureEnclave: true,
      });
    }
    if (action === "delete") {
      return jsonResult({
        ok: true,
        provider: "macos-secure-enclave-v1",
        keyTag: tag,
        publicJwk: null,
        signature: null,
        secureEnclave: true,
      });
    }
    if (action === "sign") {
      return jsonResult({
        ok: true,
        provider: "macos-secure-enclave-v1",
        keyTag: tag,
        publicJwk,
        signature: "A".repeat(86),
        secureEnclave: true,
      });
    }
    return result(1, "", "unexpected action");
  };
  const options = { spawnSync: provisionedSpawn };
  const broker = inspectProvisionedMacosTrustBroker(binary, options);
  assert(broker.identifier === "com.machine-bridge-mcp.trust-broker", "provisioned broker identifier was not retained");
  assert(broker.teamIdentifier === "ABCDEFGHIJ", "provisioned broker Team ID was not retained");
  probeProvisionedMacosTrustBroker(broker, options);
  assert(calls.some(({ args }) => args[0] === "ensure" && String(args[2]).includes(".probe.")), "capability probe did not create a temporary Secure Enclave key");
  assert(calls.some(({ args }) => args[0] === "delete" && String(args[2]).includes(".probe.")), "capability probe did not remove its temporary Secure Enclave key");

  const identity = ensureMacosSecureDeviceRoot({
    workspaceHash: "b".repeat(24),
    brokerPath: binary,
    options,
  });
  assert(identity.provider === "macos-secure-enclave-v1", "provisioned broker did not create a Secure Enclave root");
  assert(identity.brokerPath === canonicalBinary, "Secure Enclave root did not bind the canonical broker path");
  assert(identity.brokerIdentifier === broker.identifier && identity.brokerTeamIdentifier === broker.teamIdentifier, "Secure Enclave root did not bind the broker signing identity");
  assert(!identity.privateJwk, "Secure Enclave root exposed private JWK material");

  const incompleteCleanupSpawn = (command, args, processOptions) => {
    assert(processOptions?.killSignal === "SIGKILL",
      "macOS trust broker cleanup path used a soft timeout signal");
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return result(0, "", "");
    if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
      return result(0, "", [
        "Identifier=com.machine-bridge-mcp.trust-broker",
        "TeamIdentifier=ABCDEFGHIJ",
        "Signature=Apple Development: Test Identity",
      ].join("\n"));
    }
    if (command !== canonicalBinary) return result(1, "", "unexpected executable");
    const action = args[0];
    const tag = args[2];
    if (action === "ensure" && String(tag).includes(".probe.")) return provisionedSpawn(command, args, processOptions);
    if (action === "delete" && String(tag).includes(".probe.")) return provisionedSpawn(command, args, processOptions);
    if (action === "ensure") return jsonResult({
      ok: true, provider: "macos-secure-enclave-v1", keyTag: tag, publicJwk, signature: null, secureEnclave: false,
    });
    if (action === "delete") return result(1, "", "synthetic cleanup failure");
    return result(1, "", "unexpected action");
  };
  let incompleteCleanupError;
  try {
    ensureMacosSecureDeviceRoot({
      workspaceHash: "c".repeat(24), brokerPath: binary, options: { spawnSync: incompleteCleanupSpawn },
    });
  } catch (error) { incompleteCleanupError = error; }
  assert(incompleteCleanupError instanceof AggregateError
    && incompleteCleanupError.errors?.length === 2
    && incompleteCleanupError.message.includes("could not be removed"),
  "Secure Enclave rollback failure did not preserve both enrollment and cleanup errors");

  const retained = ensureMacosSecureDeviceRoot({ existing: identity, brokerPath: binary, options });
  assert(retained === identity, "existing Secure Enclave root was unnecessarily replaced");
  assert(calls.some(({ args }) => args[0] === "public" && args[2] === identity.keyTag), "existing Secure Enclave root was not verified through its bound broker");

  const signed = signWithMacosSecureDeviceRoot(identity, "device-session-transcript", { options });
  assert(signed === "A".repeat(86), "provisioned broker signature was not returned");

  const timedOutSpawn = (command, args, processOptions) => {
    assert(processOptions?.killSignal === "SIGKILL",
      "macOS trust broker timeout path used a soft timeout signal");
    if (command === "/usr/bin/codesign") return provisionedSpawn(command, args, processOptions);
    return {
      status: null, stdout: "", stderr: "", signal: "SIGKILL",
      error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
    };
  };
  expectThrow(
    () => signWithMacosSecureDeviceRoot(identity, "device-session-transcript", { options: { spawnSync: timedOutSpawn } }),
    "trust broker timed out",
  );

  const changedIdentitySpawn = (command, args, processOptions) => {
    assert(processOptions?.killSignal === "SIGKILL",
      "macOS trust broker identity verification used a soft timeout signal");
    if (command === "/usr/bin/codesign" && args[0] === "--verify") return result(0, "", "");
    if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
      return result(0, "", "Identifier=com.machine-bridge-mcp.other\nTeamIdentifier=ABCDEFGHIJ\nSignature=Apple Development: Test Identity\n");
    }
    return provisionedSpawn(command, args, processOptions);
  };
  expectThrow(
    () => signWithMacosSecureDeviceRoot(identity, "device-session-transcript", { options: { spawnSync: changedIdentitySpawn } }),
    "no longer matches",
  );

  console.log("macOS provisioned trust broker boundary test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function jsonResult(value) {
  return result(0, `${JSON.stringify(value)}\n`, "");
}

function result(status, stdout, stderr) {
  return { status, stdout, stderr, signal: null, error: null };
}

function expectThrow(callback, fragment) {
  try {
    callback();
  } catch (error) {
    assert(String(error?.message || error).includes(fragment), `unexpected error: ${error?.message || error}`);
    return;
  }
  throw new Error(`expected error containing ${fragment}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
