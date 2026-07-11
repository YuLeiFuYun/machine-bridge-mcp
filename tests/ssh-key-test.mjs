import { copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKeyPair, inspectSshKeyPair } from "../src/local/ssh-key.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-ssh-key-test-"));
try {
  const edPath = join(root, "operator-ed25519");
  const privateCommentMarker = "private-operator-label";
  const ed = await generateSshKeyPair({ privateKeyPath: edPath, comment: `${privateCommentMarker}\u202e` });
  assert(ed.created && ed.publicKeyType === "ssh-ed25519" && /^SHA256:[A-Za-z0-9+/=]+$/.test(ed.fingerprint), "Ed25519 generation failed");
  assert(!ed.fingerprint.includes(privateCommentMarker) && !ed.fingerprint.includes("\u202e"), "SSH fingerprint result exposed the public-key comment or display controls");
  const publicText = await readFile(`${edPath}.pub`, "utf8");
  assert(!publicText.includes("\u202e"), "SSH key comment retained a Unicode display control");
  const privateBytes = await readFile(edPath);
  assert(!JSON.stringify(ed).includes(privateBytes.toString("base64")), "SSH result exposed encoded private key bytes");
  if (process.platform !== "win32") assert(((await stat(edPath)).mode & 0o777) === 0o600, "Ed25519 private key mode is not 0600");
  const reused = await generateSshKeyPair({ privateKeyPath: edPath, comment: "ignored-on-reuse" });
  assert(reused.created === false && reused.fingerprint === ed.fingerprint, "existing SSH key pair was not reused idempotently");

  const rsaPath = join(root, "operator-rsa");
  const rsa = await generateSshKeyPair({ privateKeyPath: rsaPath, type: "rsa", bits: 2048, comment: "test-rsa" });
  assert(rsa.created && rsa.publicKeyType === "ssh-rsa", "RSA generation or argument ordering failed");

  const otherPath = join(root, "other-ed25519");
  await generateSshKeyPair({ privateKeyPath: otherPath, comment: "other" });
  await copyFile(`${otherPath}.pub`, `${edPath}.pub`);
  await expectReject(() => inspectSshKeyPair(edPath), "does not match");

  const incompletePath = join(root, "incomplete");
  await writeFile(incompletePath, "not-a-key", { mode: 0o600 });
  await expectReject(() => generateSshKeyPair({ privateKeyPath: incompletePath }), "incomplete");

  if (process.platform !== "win32") {
    const linkedPath = join(root, "linked-key");
    try {
      await symlink(otherPath, linkedPath);
      await symlink(`${otherPath}.pub`, `${linkedPath}.pub`);
      await expectReject(() => generateSshKeyPair({ privateKeyPath: linkedPath }), "symbolic link");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    }
  }

  console.log("SSH key generation/security test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function expectReject(callback, pattern) {
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
