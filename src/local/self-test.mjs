import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSelfTest } from "./daemon.mjs";
import { ensureWorkerSecrets, loadState, previewSecret, redactState, selectedWorkspace, setSelectedWorkspace } from "./state.mjs";

await daemonSelfTest();
await stateSelfTest();
console.log("local daemon/state self-test ok");

async function stateSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-test-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-state-workspace-"));
  try {
    setSelectedWorkspace(workspace, stateRoot);
    if (selectedWorkspace(stateRoot) !== workspace) throw new Error("selected workspace was not persisted");
    const state = loadState(workspace, { stateDir: stateRoot });
    ensureWorkerSecrets(state, { rotateSecrets: true });
    const redacted = redactState(state);
    if (redacted.worker.oauthPassword === state.worker.oauthPassword) throw new Error("oauthPassword was not redacted");
    if (redacted.worker.daemonSecret === state.worker.daemonSecret) throw new Error("daemonSecret was not redacted");
    if (redacted.worker.oauthTokenVersion === state.worker.oauthTokenVersion) throw new Error("oauthTokenVersion was not redacted");
    if (!previewSecret(state.worker.oauthPassword).includes("...")) throw new Error("previewSecret did not preview long secret");
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
