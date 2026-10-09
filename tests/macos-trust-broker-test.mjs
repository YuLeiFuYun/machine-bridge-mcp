import fs, { chmodSync, closeSync, constants as fsConstants, fstatSync, linkSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createDeviceIdentity } from "../src/local/device-identity.mjs";
import {
  buildDevelopmentTrustBrokerBinary,
  configuredMacosTrustBrokerPath,
  ensureMacosSecureDeviceRoot,
  inspectProvisionedMacosTrustBroker,
  isMacosSecureDeviceRoot,
  probeProvisionedMacosTrustBroker,
  signWithMacosSecureDeviceRoot,
} from "../src/local/macos-trust-broker.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-trust-broker-"));
const nativeLstatSync = fs.lstatSync;
try {
  expectThrow(() => configuredMacosTrustBrokerPath({ MBM_MACOS_TRUST_BROKER: ["/tmp/broker"] }), "must be a string");
  expectThrow(() => inspectProvisionedMacosTrustBroker(["/tmp/broker"]), "path must be a string");
  const binary = process.platform === "darwin"
    ? buildDevelopmentTrustBrokerBinary(root)
    : path.join(root, "synthetic-broker");
  if (process.platform !== "darwin") writeFileSync(binary, "synthetic broker; never executed", { mode: 0o700 });
  const canonicalBinary = realpathSync(binary);
  if (process.platform === "win32") {
    // Windows mode bits cannot represent an owner-executable POSIX broker.
    // Keep the native rejection, then simulate only this owned fixture's POSIX metadata.
    expectThrow(() => inspectProvisionedMacosTrustBroker(binary), "writable by group or other users");
    let syntheticMode = 0o700;
    fs.lstatSync = (target, ...args) => {
      const info = nativeLstatSync(target, ...args);
      if (target !== binary && target !== canonicalBinary) return info;
      return Object.assign(Object.create(info), { mode: (info.mode & ~0o777) | syntheticMode });
    };
    syncBuiltinESMExports();
    for (const [mode, message] of [[0o777, "writable by group or other users"], [0o600, "not executable"]]) {
      syntheticMode = mode;
      expectThrow(() => inspectProvisionedMacosTrustBroker(binary, {
        spawnSync() { throw new Error("unsafe broker metadata reached codesign"); },
      }), message);
    }
    syntheticMode = 0o700;
  }
  if (process.platform === "darwin") {
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

    testNativeKeyProvenance(root);
    await testSigningStreamBound(binary);

    const second = buildDevelopmentTrustBrokerBinary(root);
    assert(second === binary, "development trust broker cache path changed without a source change");

    appendNoFollowRegularFile(binary, Buffer.from([0]));
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
  }

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
  const options = { spawnSync: provisionedSpawn, allowNonDarwin: true };
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
  assert(isMacosSecureDeviceRoot(identity), "valid Secure Enclave root was not recognized");
  for (const field of ["brokerPath", "brokerIdentifier", "brokerTeamIdentifier", "keyTag", "createdAt"]) {
    assert(!isMacosSecureDeviceRoot({ ...identity, [field]: [identity[field]] }),
      `Secure Enclave root coerced non-string ${field} into trusted persisted identity`);
  }

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
      workspaceHash: "c".repeat(24), brokerPath: binary, options: { spawnSync: incompleteCleanupSpawn, allowNonDarwin: true },
    });
  } catch (error) { incompleteCleanupError = error; }
  assert(incompleteCleanupError instanceof AggregateError
    && incompleteCleanupError.errors?.length === 2
    && incompleteCleanupError.message.includes("could not be removed"),
  "Secure Enclave rollback failure did not preserve both enrollment and cleanup errors");

  for (const phase of ["probe", "enrollment"]) {
    for (const failure of ["invalid_json", "timeout"]) {
      const syntheticKeys = new Set();
      const faultSpawn = (command, args, processOptions) => {
        if (command === "/usr/bin/codesign") return provisionedSpawn(command, args, processOptions);
        const [action, , tag] = args;
        if (action === "ensure") {
          syntheticKeys.add(tag);
          if ((phase === "probe") === tag.includes(".probe.")) {
            return failure === "invalid_json"
              ? result(0, "{", "")
              : { status: null, stdout: "", stderr: "", signal: "SIGKILL", error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) };
          }
        }
        if (action === "delete") syntheticKeys.delete(tag);
        return provisionedSpawn(command, args, processOptions);
      };
      const faultOptions = { ...options, spawnSync: faultSpawn };
      expectThrow(
        () => phase === "probe"
          ? probeProvisionedMacosTrustBroker(binary, faultOptions)
          : ensureMacosSecureDeviceRoot({ brokerPath: binary, options: faultOptions }),
        failure === "invalid_json" ? "invalid JSON" : "timed out",
      );
      assert(syntheticKeys.size === 0, "failed broker response left a newly created synthetic key behind");
    }
    const badCleanupSpawn = (command, args, processOptions) => {
      if (command === "/usr/bin/codesign") return provisionedSpawn(command, args, processOptions);
      const [action, , tag] = args;
      if ((phase === "probe") === tag.includes(".probe.")) {
        if (action === "ensure") return result(0, "{", "");
        if (action === "delete") return jsonResult({ ok: "false", provider: identity.provider, keyTag: tag });
      }
      return provisionedSpawn(command, args, processOptions);
    };
    let cleanupFailure;
    try {
      const faultOptions = { ...options, spawnSync: badCleanupSpawn };
      if (phase === "probe") probeProvisionedMacosTrustBroker(binary, faultOptions);
      else ensureMacosSecureDeviceRoot({ brokerPath: binary, options: faultOptions });
    } catch (error) { cleanupFailure = error; }
    assert(cleanupFailure instanceof AggregateError && cleanupFailure.errors.length === 2
      && cleanupFailure.errors[0].message.includes("invalid JSON")
      && cleanupFailure.errors[1].message.includes("invalid key deletion result"),
    "probe/enrollment cleanup replaced the original error or accepted a malformed deletion receipt");
  }
  for (const deletionOverride of [{ ok: "false" }, { provider: "wrong" }, { keyTag: "wrong" }]) {
    const badDeletionSpawn = (command, args, processOptions) => {
      if (command !== "/usr/bin/codesign" && args[0] === "delete") {
        return jsonResult({ ok: true, provider: identity.provider, keyTag: args[2], ...deletionOverride });
      }
      return provisionedSpawn(command, args, processOptions);
    };
    expectThrow(() => probeProvisionedMacosTrustBroker(binary, { ...options, spawnSync: badDeletionSpawn }),
      "invalid key deletion result");
  }
  const badKeySpawn = (command, args, processOptions) => {
    if (command !== "/usr/bin/codesign" && ["ensure", "public"].includes(args[0])) {
      return jsonResult({ ok: "false", provider: identity.provider, keyTag: args[2], publicJwk, secureEnclave: true });
    }
    return provisionedSpawn(command, args, processOptions);
  };
  expectThrow(() => probeProvisionedMacosTrustBroker(binary, { ...options, spawnSync: badKeySpawn }), "invalid key result");
  const deleteCount = calls.filter(({ args }) => args[0] === "delete").length;
  expectThrow(() => ensureMacosSecureDeviceRoot({ existing: identity, options: { ...options, spawnSync: badKeySpawn } }), "invalid key result");
  assert(calls.filter(({ args }) => args[0] === "delete").length === deleteCount,
    "failed existing-root verification attempted to delete the enrolled key");
  for (const signatureOverride of [{ ok: "false" }, { signature: ["A".repeat(86)] }]) {
    const badSignatureSpawn = (command, args, processOptions) => {
      if (command !== "/usr/bin/codesign" && args[0] === "sign") {
        return jsonResult({ ok: true, provider: identity.provider, keyTag: args[2], publicJwk, signature: "A".repeat(86), ...signatureOverride });
      }
      return provisionedSpawn(command, args, processOptions);
    };
    expectThrow(() => signWithMacosSecureDeviceRoot(identity, "synthetic transcript", { options: { ...options, spawnSync: badSignatureSpawn } }),
      "invalid signature result");
  }

  const retained = ensureMacosSecureDeviceRoot({ existing: identity, brokerPath: binary, options });
  assert(retained === identity, "existing Secure Enclave root was unnecessarily replaced");
  assert(calls.some(({ args }) => args[0] === "public" && args[2] === identity.keyTag), "existing Secure Enclave root was not verified through its bound broker");

  const signed = signWithMacosSecureDeviceRoot(identity, "device-session-transcript", { options });
  assert(signed === "A".repeat(86), "provisioned broker signature was not returned");
  expectThrow(() => signWithMacosSecureDeviceRoot(identity, ["device-session-transcript"], { options }),
    "signing transcript is empty or too large");

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
  fs.lstatSync = nativeLstatSync;
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}

function appendNoFollowRegularFile(file, bytes) {
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  assert(noFollow !== 0, "macOS trust broker tamper test requires O_NOFOLLOW");
  let fd;
  try {
    fd = openSync(file, Number(fsConstants.O_WRONLY) | Number(fsConstants.O_APPEND) | noFollow);
    const info = fstatSync(fd);
    assert(info.isFile(), "development trust broker tamper target is not a regular file");
    assert(info.nlink === 1, "development trust broker tamper target has multiple hard links");
    assert(writeSync(fd, bytes) === bytes.length, "development trust broker tamper write was incomplete");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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

function testNativeKeyProvenance(fixtureRoot) {
  const nativeSource = readFileSync(new URL("../native/macos/MachineBridgeTrustBroker.swift", import.meta.url), "utf8");
  const declarationEnd = nativeSource.indexOf("@main");
  const functionStart = nativeSource.indexOf("private func ensurePrivateKey");
  assert(declarationEnd > 0 && functionStart > declarationEnd, "native broker fixture cannot isolate producer declarations");
  const producer = (nativeSource.slice(0, declarationEnd) + nativeSource.slice(functionStart))
    .replaceAll("SecItemCopyMatching(", "fixtureCopyMatching(")
    .replaceAll("SecItemDelete(", "fixtureDelete(")
    .replaceAll("SecKeyCreateRandomKey(", "fixtureCreateRandomKey(")
    .replaceAll("SecKeyCopyAttributes(", "fixtureKeyAttributes(");
  const driver = path.join(fixtureRoot, "owned-key-provenance.swift");
  const fixtureBinary = path.join(fixtureRoot, "owned-key-provenance");
  writeFileSync(driver, producer + String.raw`
private var lookupStatus: OSStatus = errSecSuccess
private var lookupValue: CFTypeRef?
private var ownedKey: SecKey!
private var hardwareAttributes = false
private var generationCount = 0
private var deletionCount = 0
private var lastDelete: NSDictionary?

private func fixtureCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    let attributes = query as NSDictionary
    precondition(attributes[kSecAttrKeyClass] as? String == kSecAttrKeyClassPrivate as String)
    if lookupStatus == errSecSuccess { result?.pointee = lookupValue }
    return lookupStatus
}
private func fixtureCreateRandomKey(_ attributes: CFDictionary, _ error: UnsafeMutablePointer<Unmanaged<CFError>?>?) -> SecKey? {
    precondition((attributes as NSDictionary)[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String)
    generationCount += 1
    return ownedKey
}
private func fixtureKeyAttributes(_ key: SecKey) -> CFDictionary? {
    guard hardwareAttributes else { return SecKeyCopyAttributes(key) }
    return [
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
    ] as CFDictionary
}
private func fixtureDelete(_ query: CFDictionary) -> OSStatus {
    deletionCount += 1
    lastDelete = query as NSDictionary
    return errSecSuccess
}
private func expectFailure(_ operation: () throws -> Void, _ fragment: String) {
    do { try operation(); fatalError("expected failure: \(fragment)") }
    catch { precondition(String(describing: error).contains(fragment), "unexpected error: \(error)") }
}
@main
private struct OwnedTrustBrokerFixture {
    static func main() throws {
        var error: Unmanaged<CFError>?
        let softwareAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ]
        guard let software = SecKeyCreateRandomKey(softwareAttributes as CFDictionary, &error) else {
            fatalError("nonpersistent software fixture failed")
        }
        ownedKey = software
        lookupValue = software
        expectFailure({ _ = try output(tag: "owned-fixture", key: software, signature: nil) }, "not a Secure Enclave")
        expectFailure({ _ = try loadPrivateKey(tag: "owned-fixture", prompt: nil, allowInteraction: false) }, "not a Secure Enclave")
        expectFailure({ _ = try ensurePrivateKey(tag: "owned-fixture") }, "not a Secure Enclave")
        expectFailure({ try deletePrivateKey(tag: "owned-fixture") }, "not a Secure Enclave")
        precondition(generationCount == 0 && deletionCount == 0, "software key was replaced or deleted")
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecParam] {
            lookupStatus = status
            expectFailure({ _ = try ensurePrivateKey(tag: "owned-fixture") }, "load Secure Enclave key")
            expectFailure({ try deletePrivateKey(tag: "owned-fixture") }, "load Secure Enclave key")
        }
        precondition(generationCount == 0 && deletionCount == 0, "lookup failure created or deleted a key")
        lookupStatus = errSecItemNotFound
        let absent = try existingPrivateKey(tag: "owned-fixture")
        precondition(absent == nil)
        try deletePrivateKey(tag: "owned-fixture")
        precondition(deletionCount == 0)
        expectFailure({ _ = try ensurePrivateKey(tag: "owned-fixture") }, "not a Secure Enclave")
        precondition(generationCount == 2, "missing key did not take only availability and creation paths")
        lookupStatus = errSecSuccess
        lookupValue = "invalid reference" as CFString
        expectFailure({ _ = try loadPrivateKey(tag: "owned-fixture", prompt: nil, allowInteraction: false) }, "invalid key reference")
        lookupValue = software
        hardwareAttributes = true // Synthetic attributes only; no actual Secure Enclave enrollment.
        let retained = try ensurePrivateKey(tag: "owned-fixture")
        precondition(CFEqual(retained, software) && generationCount == 2)
        try deletePrivateKey(tag: "owned-fixture")
        precondition(deletionCount == 1)
        let references = lastDelete?[kSecMatchItemList] as? [SecKey]
        precondition(references?.count == 1 && CFEqual(references![0], software))
        precondition(lastDelete?[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String)
        precondition(lastDelete?[kSecReturnRef] == nil && lastDelete?[kSecMatchLimit] == nil)
        let fixturePath = CommandLine.arguments[1]
        let file = URL(fileURLWithPath: fixturePath)
        for count in [1, 64 * 1024] {
            try Data(repeating: 0x61, count: count).write(to: file)
            let input = try FileHandle(forReadingFrom: file)
            let data = try readSigningInput(input)
            try input.close()
            precondition(data.count == count)
        }
        for data in [Data(), Data([0xff]), Data(repeating: 0x61, count: 64 * 1024 + 1)] {
            try data.write(to: file)
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            expectFailure({ _ = try readSigningInput(input) }, data == Data([0xff]) ? "not UTF-8" : "empty or too large")
        }
        print("owned native key provenance and bounded signing input ok")
    }
}
`, { mode: 0o600 });
  // Match the production driver, which selects the active SDK; a resolved toolchain binary does not.
  const built = spawnSync("/usr/bin/swiftc", ["-parse-as-library", driver, "-o", fixtureBinary], {
    encoding: "utf8", killSignal: "SIGKILL", timeout: 120_000, maxBuffer: 512 * 1024,
  });
  assert(built.status === 0 && !built.error, "native provenance fixture did not compile: " + built.stderr);
  const tested = spawnSync(fixtureBinary, [path.join(fixtureRoot, "owned-signing-input")], {
    encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000,
  });
  assert(tested.status === 0 && !tested.error, "native provenance fixture failed: " + tested.stderr);
}

async function testSigningStreamBound(binary) {
  const child = spawn(binary, ["sign", "--tag", "owned-stream-fixture"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = ""; let timer;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.on("error", () => { /* Rejection may close the pipe while the owned fixture is writing. */ });
  try {
    const settled = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => reject(new Error("native broker waited for EOF after oversized signing input")), 10_000);
    });
    child.stdin.write(Buffer.alloc(64 * 1024 + 1, 0x61)); // Keep stdin open to prove early bounded rejection.
    const result = await settled;
    assert(result.code === 1 && result.signal === null && stderr.includes("signing input is empty or too large"),
      "native broker did not reject oversized open stdin before Keychain access");
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
