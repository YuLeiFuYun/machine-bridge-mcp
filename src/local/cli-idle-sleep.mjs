import { configuredIdleSleepMode, defaultStateRoot, expandHome, setConfiguredIdleSleepMode } from "./state.mjs";

export function idleSleepCommand(args = {}) {
  const action = String(args._?.[0] || "show");
  const stateRoot = args.stateDir ? expandHome(String(args.stateDir)) : defaultStateRoot();
  if (action === "show") { console.log(configuredIdleSleepMode(stateRoot)); return; }
  if (action === "set") {
    const mode = args._?.[1];
    if (!mode) throw new Error("idle-sleep set requires activity, ac-continuous, or continuous");
    const configured = setConfiguredIdleSleepMode(mode, stateRoot);
    console.log(`Idle-sleep mode set to ${configured}. Restart the daemon/service to apply it.`);
    return;
  }
  throw new Error(`Unknown idle-sleep action: ${action}`);
}
