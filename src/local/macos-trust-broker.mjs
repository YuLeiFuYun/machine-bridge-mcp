import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deviceKeyId } from "./device-identity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROVIDER = "macos-secure-enclave-v1";
const BROKER_PROTOCOL = 1;
const BROKER_ENVIRONMENT_VARIABLE = "MBM_MACOS_TRUST_BROKER";
const SOURCE_RELATIVE = "native/macos/MachineBridgeTrustBroker.swift";
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_DEVELOPMENT_BROKER_BYTES = 16 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/;
const TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/;

export class MacosTrustBrokerUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "MacosTrustBrokerUnavailableError";
    this.code = "MBM_MACOS_TRUST_BROKER_UNAVAILABLE";
  }
}

export function configuredMacosTrustBrokerPath(env = process.env) {
  const value = String(env?.[BROKER_ENVIRONMENT_VARIABLE] || "").trim();
  if (!value) return null;
  if (!path.isAbsolute(value)) throw new MacosTrustBrokerUnavailableError(`${BROKER_ENVIRONMENT_VARIABLE} must be an absolute path`);
  return value;
}

export function isMacosSecureDeviceRoot(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.provider === PROVIDER
    && value.brokerProtocol === BROKER_PROTOCOL
    && path.isAbsolute(String(value.brokerPath || ""))
    && IDENTIFIER_PATTERN.test(String(value.brokerIdentifier || ""))
    && TEAM_IDENTIFIER_PATTERN.test(String(value.brokerTeamIdentifier || ""))
    && /^com\.machine-bridge-mcp\.device\.[A-Za-z0-9._-]{8,160}$/.test(String(value.keyTag || ""))
    && value.publicJwk?.kty === "EC"
    && value.publicJwk?.crv === "P-256"
    && typeof value.publicJwk?.x === "string"
    && typeof value.publicJwk?.y === "string"
    && value.keyId === deviceKeyId(value.publicJwk)
    && Number.isFinite(Date.parse(String(value.createdAt || "")))
  );
}

export function ensureMacosSecureDeviceRoot({ workspaceHash, existing = null, rotate = false, brokerPath = null, options = {} } = {}) {
  if (process.platform !== "darwin" && !options.allowNonDarwin) {
    throw new MacosTrustBrokerUnavailableError("macOS Secure Enclave provider is unavailable on this platform");
  }
  const selectedPath = brokerPath || existing?.brokerPath || configuredMacosTrustBrokerPath(options.env);
  if (!selectedPath) {
    throw new MacosTrustBrokerUnavailableError(
      `Secure Enclave enrollment requires a provisioned app-like broker configured through ${BROKER_ENVIRONMENT_VARIABLE}`,
    );
  }
  const broker = inspectProvisionedMacosTrustBroker(selectedPath, options);
  if (!rotate && isMacosSecureDeviceRoot(existing)) {
    assertBrokerBinding(existing, broker);
    const result = runBroker(broker.path, ["public", "--tag", existing.keyTag], { timeoutMs: 30_000 }, options);
    assertBrokerKeyResult(result, existing.keyTag);
    if (deviceKeyId(result.publicJwk) !== existing.keyId) throw new Error("provisioned macOS trust broker returned a different device root");
    return existing;
  }

  probeProvisionedMacosTrustBroker(broker, options);
  const tagSuffix = randomBytes(18).toString("base64url").replaceAll("_", "-");
  const tag = `com.machine-bridge-mcp.device.${String(workspaceHash || "workspace").slice(0, 24)}.${tagSuffix}`;
  let created = false;
  try {
    const result = runBroker(broker.path, ["ensure", "--tag", tag], { timeoutMs: 30_000 }, options);
    created = true;
    assertBrokerKeyResult(result, tag);
    const identity = {
      scheme: "device-signature-v1",
      provider: PROVIDER,
      brokerProtocol: BROKER_PROTOCOL,
      brokerPath: broker.path,
      brokerIdentifier: broker.identifier,
      brokerTeamIdentifier: broker.teamIdentifier,
      keyTag: tag,
      publicJwk: result.publicJwk,
      keyId: deviceKeyId(result.publicJwk),
      createdAt: new Date().toISOString(),
    };
    if (!isMacosSecureDeviceRoot(identity)) throw new Error("Secure Enclave device root failed local validation");
    return identity;
  } catch (error) {
    let cleanupError = null;
    if (created) {
      try { runBroker(broker.path, ["delete", "--tag", tag], { timeoutMs: 30_000 }, options); }
      catch (failure) { cleanupError = failure; }
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Secure Enclave enrollment failed and the newly created key could not be removed; inspect the provisioned trust broker before retrying",
      );
    }
    throw error;
  }
}

export function signWithMacosSecureDeviceRoot(identity, transcript, { reason = "Authorize Machine Bridge startup", options = {} } = {}) {
  if (!isMacosSecureDeviceRoot(identity)) throw new Error("Secure Enclave device root is invalid");
  const input = Buffer.from(String(transcript), "utf8");
  if (!input.length || input.length > MAX_TRANSCRIPT_BYTES) throw new Error("device root signing transcript is empty or too large");
  const broker = inspectProvisionedMacosTrustBroker(identity.brokerPath, options);
  assertBrokerBinding(identity, broker);
  const result = runBroker(broker.path, ["sign", "--tag", identity.keyTag, "--reason", sanitizeReason(reason)], {
    input,
    timeoutMs: 120_000,
  }, options);
  if (!result.ok || result.provider !== PROVIDER || result.keyTag !== identity.keyTag || !/^[A-Za-z0-9_-]{86}$/.test(String(result.signature || ""))) {
    throw new Error("Secure Enclave broker returned an invalid signature result");
  }
  if (result.publicJwk && deviceKeyId(result.publicJwk) !== identity.keyId) {
    throw new Error("Secure Enclave broker key identity changed before signing");
  }
  return result.signature;
}

export function inspectProvisionedMacosTrustBroker(binaryPath, options = {}) {
  const raw = String(binaryPath || "");
  if (!path.isAbsolute(raw)) throw new MacosTrustBrokerUnavailableError("macOS trust broker path must be absolute");
  let info;
  let resolved;
  try {
    const direct = lstatSync(raw);
    if (direct.isSymbolicLink()) throw new MacosTrustBrokerUnavailableError("macOS trust broker path must not be a symbolic link");
    resolved = realpathSync(raw);
    info = lstatSync(resolved);
  } catch (error) {
    if (error instanceof MacosTrustBrokerUnavailableError) throw error;
    throw new MacosTrustBrokerUnavailableError(`macOS trust broker is unavailable: ${boundedDiagnostic(error?.message)}`, { cause: error });
  }
  if (!info.isFile()) throw new MacosTrustBrokerUnavailableError("macOS trust broker is not a regular file");
  if ((info.mode & 0o022) !== 0) throw new MacosTrustBrokerUnavailableError("macOS trust broker is writable by group or other users");
  if ((info.mode & 0o111) === 0) throw new MacosTrustBrokerUnavailableError("macOS trust broker is not executable");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && info.uid !== currentUid && info.uid !== 0) {
    throw new MacosTrustBrokerUnavailableError("macOS trust broker must be owned by the current user or root");
  }

  const spawn = options.spawnSync || spawnSync;
  const verify = spawn("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", resolved], codesignOptions());
  if (verify.status !== 0 || verify.error) {
    throw new MacosTrustBrokerUnavailableError(`macOS trust broker code signature is invalid (${boundedDiagnostic(verify.stderr || verify.error?.message)})`);
  }
  const describe = spawn("/usr/bin/codesign", ["-dvvv", resolved], codesignOptions());
  if (describe.status !== 0 || describe.error) {
    throw new MacosTrustBrokerUnavailableError(`macOS trust broker signature metadata is unavailable (${boundedDiagnostic(describe.stderr || describe.error?.message)})`);
  }
  const metadata = parseCodesignMetadata(describe.stderr || describe.stdout);
  if (!TEAM_IDENTIFIER_PATTERN.test(metadata.teamIdentifier) || metadata.signature.toLowerCase() === "adhoc") {
    throw new MacosTrustBrokerUnavailableError(
      "macOS trust broker must be signed by an Apple development or distribution identity and validated by a provisioning profile; ad-hoc signing cannot access the data-protection Keychain",
    );
  }
  if (!IDENTIFIER_PATTERN.test(metadata.identifier)) throw new MacosTrustBrokerUnavailableError("macOS trust broker has no stable code-signing identifier");
  return { path: resolved, identifier: metadata.identifier, teamIdentifier: metadata.teamIdentifier };
}

export function probeProvisionedMacosTrustBroker(brokerOrPath, options = {}) {
  const broker = typeof brokerOrPath === "string" ? inspectProvisionedMacosTrustBroker(brokerOrPath, options) : brokerOrPath;
  const tag = `com.machine-bridge-mcp.device.probe.${randomBytes(18).toString("base64url").replaceAll("_", "-")}`;
  let created = false;
  let probeError = null;
  try {
    const result = runBroker(broker.path, ["ensure", "--tag", tag], { timeoutMs: 30_000 }, options);
    created = true;
    assertBrokerKeyResult(result, tag);
  } catch (error) {
    probeError = error instanceof MacosTrustBrokerUnavailableError
      ? error
      : new MacosTrustBrokerUnavailableError(
        `macOS trust broker failed its Secure Enclave capability probe (${boundedDiagnostic(error?.message)})`,
        { cause: error },
      );
  }
  if (created) {
    const deleted = runBroker(broker.path, ["delete", "--tag", tag], { timeoutMs: 30_000 }, options);
    if (!deleted.ok || deleted.provider !== PROVIDER || deleted.keyTag !== tag) {
      throw new MacosTrustBrokerUnavailableError("macOS trust broker could not remove its capability-probe key");
    }
  }
  if (probeError) throw probeError;
  return broker;
}

export function buildDevelopmentTrustBrokerBinary(profileDir, options = {}) {
  if (process.platform !== "darwin") throw new Error("macOS trust broker build is unavailable on this platform");
  const source = path.resolve(options.packageRoot || packageRoot, SOURCE_RELATIVE);
  const sourceBytes = readBoundedRegularFileSync(source, 2 * 1024 * 1024, "macOS trust broker source", {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const directory = path.resolve(profileDir, "native", "macos");
  ensureOwnerOnlyDirectorySync(directory);
  const binary = path.join(directory, "machine-bridge-trust-broker-development");
  const marker = path.join(directory, "machine-bridge-trust-broker-development.sha256");
  const currentMarker = readDevelopmentBrokerMarker(marker);
  const existingBinary = inspectDevelopmentBrokerBinary(binary);
  if (existingBinary && currentMarker?.sourceSha256 === sourceDigest) {
    const binaryBytes = readBoundedRegularFileSync(binary, MAX_DEVELOPMENT_BROKER_BYTES, "macOS development trust broker", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
    const binaryDigest = createHash("sha256").update(binaryBytes).digest("hex");
    if (binaryDigest === currentMarker.binarySha256) return binary;
  }

  const temporary = path.join(directory, `.machine-bridge-trust-broker.${process.pid}.${randomBytes(6).toString("hex")}`);
  const compiler = options.swiftc || "/usr/bin/swiftc";
  let compiledBytes;
  let primaryError = null;
  try {
    const compile = (options.spawnSync || spawnSync)(compiler, [
      "-parse-as-library", "-O", "-framework", "Security", "-framework", "LocalAuthentication", source, "-o", temporary,
    ], {
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      env: minimalEnvironment(),
    });
    if (compile.status !== 0 || compile.error) {
      throw new Error(`could not build macOS trust broker (${boundedDiagnostic(compile.stderr || compile.error?.message)})`);
    }
    const sign = (options.spawnSync || spawnSync)("/usr/bin/codesign", ["--force", "--sign", "-", temporary], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      env: minimalEnvironment(),
    });
    if (sign.status !== 0 || sign.error) {
      throw new Error(`could not ad-hoc sign development macOS trust broker (${boundedDiagnostic(sign.stderr || sign.error?.message)})`);
    }
    compiledBytes = readBoundedRegularFileSync(temporary, MAX_DEVELOPMENT_BROKER_BYTES, "compiled macOS development trust broker", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { (options.unlinkSync || unlinkSync)(temporary); }
  catch (error) {
    if (error?.code !== "ENOENT") cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "macOS development trust broker build failed and temporary cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw new Error("macOS development trust broker temporary cleanup failed", { cause: cleanupError });

  const binaryDigest = createHash("sha256").update(compiledBytes).digest("hex");
  replaceFileAtomicallySync(binary, compiledBytes, { mode: 0o700 });
  replaceFileAtomicallySync(marker, `${JSON.stringify({
    schema: 1,
    source_sha256: sourceDigest,
    binary_sha256: binaryDigest,
  })}
`, { mode: 0o600 });
  return binary;
}

function readDevelopmentBrokerMarker(marker) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(marker, 512, "macOS development trust broker digest", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== 1
      || !/^[0-9a-f]{64}$/.test(String(value.source_sha256 || ""))
      || !/^[0-9a-f]{64}$/.test(String(value.binary_sha256 || ""))) return null;
  return { sourceSha256: value.source_sha256, binarySha256: value.binary_sha256 };
}

function inspectDevelopmentBrokerBinary(binary) {
  let info;
  try { info = lstatSync(binary); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("macOS development trust broker must be a regular file and not a symbolic link");
  }
  if (Number(info.nlink) > 1) throw new Error("macOS development trust broker must not have multiple hard links");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700)) {
    throw new Error("macOS development trust broker must remain owner-only and owner-executable");
  }
  return info;
}

function assertBrokerBinding(identity, broker) {
  if (identity.brokerPath !== broker.path
      || identity.brokerIdentifier !== broker.identifier
      || identity.brokerTeamIdentifier !== broker.teamIdentifier) {
    throw new Error("macOS trust broker signing identity no longer matches the enrolled device root");
  }
}

function assertBrokerKeyResult(result, tag) {
  if (!result?.ok || result.provider !== PROVIDER || result.keyTag !== tag || result.secureEnclave !== true || !result.publicJwk) {
    throw new Error("Secure Enclave broker returned an invalid key result");
  }
  deviceKeyId(result.publicJwk);
}

function runBroker(binary, args, { input, timeoutMs }, options = {}) {
  const result = (options.spawnSync || spawnSync)(binary, args, {
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    env: minimalEnvironment(),
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const diagnostic = boundedDiagnostic(result.stderr || result.error?.message || result.signal || `exit ${result.status}`);
    if (result.error?.code === "ETIMEDOUT") {
      throw new MacosTrustBrokerUnavailableError("macOS trust broker timed out");
    }
    if (/-34018|missing entitlement|required entitlement/i.test(diagnostic)) {
      throw new MacosTrustBrokerUnavailableError(
        "macOS trust broker lacks a provisioning-profile-validated data-protection Keychain entitlement",
      );
    }
    if (result.signal === "SIGKILL" || result.status === 137) {
      throw new MacosTrustBrokerUnavailableError("macOS rejected the trust broker code signature or entitlements");
    }
    throw new Error(`macOS trust broker failed (${diagnostic})`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("macOS trust broker returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("macOS trust broker returned an invalid result");
  return parsed;
}

function parseCodesignMetadata(value) {
  const metadata = { identifier: "", teamIdentifier: "", signature: "" };
  for (const line of String(value || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const entry = line.slice(index + 1).trim();
    if (key === "Identifier") metadata.identifier = entry;
    else if (key === "TeamIdentifier") metadata.teamIdentifier = entry;
    else if (key === "Signature") metadata.signature = entry;
  }
  return metadata;
}

function codesignOptions() {
  return {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    env: minimalEnvironment(),
  };
}

function minimalEnvironment() {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "en_US.UTF-8",
  };
}

function sanitizeReason(value) {
  return String(value || "Authorize Machine Bridge startup").replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) || "Authorize Machine Bridge startup";
}

function boundedDiagnostic(value) {
  return String(value || "unknown error").replace(/[\r\n\t]+/g, " ").trim().slice(0, 600);
}
