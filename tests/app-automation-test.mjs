import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AppAutomationManager, powershellSingleQuotedLiteral } from "../src/local/app-automation.mjs";
import { BridgeError, publicError } from "../src/local/errors.mjs";
import { LocalRuntime } from "../src/local/runtime.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-app-automation-"));
const applications = join(root, "Applications");
await mkdir(join(applications, "Example.app"), { recursive: true });
await mkdir(join(applications, "Utilities", "Nested Utility.app"), { recursive: true });
const invalidApplicationRoot = join(root, "not-a-directory");
await writeFile(invalidApplicationRoot, "not a directory", "utf8");
const calls = [];
const resourceReads = [];
const keyboardCalls = [];
let applicationClock = 0;
const manager = new AppAutomationManager({
  policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
  platform: "darwin",
  home: root,
  applicationRoots: [applications, invalidApplicationRoot],
  applicationCacheMs: 100,
  now: () => applicationClock,
  backgroundInputService: {
    async keystroke(args) {
      keyboardCalls.push({ action: "keystroke", args });
      return { ok: true, dispatch_started: true, input_transport: "public-cgevent-pid" };
    },
    async keyPress(args) {
      keyboardCalls.push({ action: "key_press", args });
      return { ok: true, dispatch_started: true, input_transport: "public-cgevent-pid" };
    },
  },
  displayPath: (value) => value,
  readResourceText: async (name) => {
    resourceReads.push(name);
    return name === "account-secret" ? "local-secret" : "";
  },
  runProcess: async (cmd, argv, timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin, options = {}) => {
    calls.push({ cmd, argv, timeoutMs, stdin, options });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "inspect") {
        return { code: 0, stdout: JSON.stringify({
          process_id: 987,
          process_generation: "gen-987",
          frontmost: false,
          elements: [],
          truncated: false,
          menus_included: payload.includeMenus === true,
          ...(payload.includeWindowState === true ? {
            window_state: {
              process_id: 987,
              process_generation: "gen-987",
              front_bounds: { x: 10, y: 20, width: 640, height: 480 },
              front_title: "Fixture",
              candidates: [{ window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 }, title: "Fixture" }],
            },
          } : {}),
        }), stderr: "" };
      }
      if (payload.operation === "verify_value") {
        return { code: 0, stdout: JSON.stringify({ supported: true, matched: payload.value === "local-secret", matched_count: 1, selected_index: 0, reason: "compared" }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({
        ok: true,
        matched: 1,
        ...(payload.action === "set_value" ? { element: { sensitive: payload.selector?.identifier === "secure" } } : {}),
        ...(payload.action === "focus" ? { element: { focused: true, sensitive: false } } : {}),
        ...(payload.includeProcessGeneration === true ? { process_id: 987, process_generation: "gen-987" } : {}),
      }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
});
try {
  const listed = await manager.listApplications({ query: "example" });
  assert(listed.applications.length === 1 && listed.applications[0].name === "Example", "macOS application discovery failed");
  assert(listed.warnings.length === 1 && typeof listed.warnings[0].error_class === "string"
    && listed.warnings[0].error_class.length > 0,
  "partial application discovery silently hid an unreadable root");
  const nested = await manager.listApplications({ query: "nested utility" });
  assert(nested.applications.length === 1 && nested.applications[0].name === "Nested Utility", "nested macOS application discovery failed");
  await expectReject(() => manager.listApplications({ query: ["example"] }), "query must be a string");
  await expectReject(() => manager.listApplications({ query: null }), "query must be a string");
  await expectReject(() => manager.listApplications({ max_results: null }), "expected an integer");
  await expectReject(() => manager.listApplications({ max_results: 1001 }), "expected an integer");
  assert(listed.capabilities.arbitrary_script_execution === false, "application capabilities claim arbitrary script support");
  await mkdir(join(applications, "Late Arrival.app"), { recursive: true });
  const cachedLate = await manager.listApplications({ query: "late arrival" });
  assert(cachedLate.applications.length === 0, "application discovery cache did not stabilize repeated resolver scans");
  applicationClock = 101;
  const refreshedLate = await manager.listApplications({ query: "late arrival" });
  assert(refreshedLate.applications.length === 1, "application discovery cache did not refresh after its bounded lifetime");

  let cancelledDiscovery = false;
  let discoveryScans = 0;
  const cancellationSafeCache = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    applicationCacheMs: 30_000,
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    throwIfCancelled: () => { if (cancelledDiscovery) throw new BridgeError("cancelled", "operation cancelled"); },
  });
  cancellationSafeCache.scanApplications = async () => {
    discoveryScans += 1;
    cancelledDiscovery = discoveryScans === 1;
    return { applications: [{ id: "Example", name: "Example", path: join(applications, "Example.app"), kind: "application-bundle" }], warnings: [], truncated: false, visitedEntries: 1 };
  };
  const cancelledDiscoveryError = await captureError(() => cancellationSafeCache.discoverApplications());
  assert(cancelledDiscoveryError?.code === "cancelled",
    "cancelled application discovery refresh completed and populated the cache");
  assert(cancellationSafeCache.applicationCache === null, "cancelled application discovery poisoned the shared inventory cache");
  cancelledDiscovery = false;
  const recoveredDiscovery = await cancellationSafeCache.discoverApplications();
  assert(recoveredDiscovery.applications.length === 1, "application discovery did not recover after the cancelled refresh");
  assert(discoveryScans === 2, "ordinary application discovery reused a result produced by a cancelled refresh");
  await cancellationSafeCache.discoverApplications();
  assert(discoveryScans === 2, "successful application discovery no longer populated the bounded cache");

  const openCallCount = calls.length;
  await expectReject(() => manager.openApplication({ application: "Example", target: null }), "target must be a string");
  await expectReject(() => manager.openApplication({ application: "Example", background: null }), "background must be boolean");
  await expectReject(() => manager.openApplication({ application: "Example", timeout_seconds: null }), "expected an integer");
  await expectReject(() => manager.openApplication({ application: "Example", timeout_seconds: 121 }), "expected an integer");
  assert(calls.length === openCallCount, "malformed application launch metadata reached the process launcher");
  const opened = await manager.openApplication({ application: "Example", target: "https://example.test/" });
  assert(opened.code === 0 && calls.at(-1).cmd === "open", "application launcher did not use the macOS launcher");
  assert(JSON.stringify(calls.at(-1).argv) === JSON.stringify(["-a", "Example", "https://example.test/"]), "application launcher arguments are incorrect");
  assert(calls.at(-1).options?.nonReplayableMutation === true,
    "application launcher did not request process-level non-replayable settlement");

  await expectReject(() => manager.operateApplication({ application: "Example", action: "set_value", selector: { role: "AXTextField" }, value: "bad\0value" }), "contains a NUL byte");
  const beforeMissingValue = calls.length;
  await expectReject(() => manager.operateApplication({ application: "Example", action: "keystroke", selector: { role: "AXTextField" } }), "requires value or value_resource");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "set_value", selector: { role: "AXTextField" } }), "requires value or value_resource");
  assert(calls.length === beforeMissingValue, "application value validation occurred after the fixed JXA helper was dispatched");
  const callsBeforeCoercibleAuthority = calls.length;
  const readsBeforeCoercibleAuthority = resourceReads.length;
  await expectReject(() => manager.operateApplication({ application: ["Example"], action: "click", selector: { role: "AXButton" } }), "application must be a non-empty name");
  await expectReject(() => manager.operateApplication({ application: "Example", action: ["click"], selector: { role: "AXButton" } }), "action must be one of");
  await expectReject(() => manager.operateApplication({ application: "Example", action: " click ", selector: { role: "AXButton" } }), "action must be one of");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "click", selector: { role: null } }), "selector.role must be a string");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "click", selector: { role: "AXButton", index: [0] } }), "expected an integer");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value_resource: ["account-secret"] }), "value_resource is invalid");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value_resource: " account-secret" }), "value_resource is invalid");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "key_press", selector: { role: "AXTextField" }, key: ["Enter"] }), "requires a valid key");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "key_press", selector: { role: "AXTextField" }, key: " Shift+Tab " }), "supports Enter, Tab, Escape");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "set_value", selector: { role: "AXTextField" }, value: ["text"] }), "application action value must be a string");
  await expectReject(() => manager.operateApplication({ application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value: { text: "x" } }), "application action value must be a string");
  assert(calls.length === callsBeforeCoercibleAuthority && resourceReads.length === readsBeforeCoercibleAuthority,
    "coercible application mutation authority reached JXA or resolved a local resource");
  const resourceReadsBeforeMalformedMetadata = resourceReads.length;
  for (const [invalidArgs, expected] of [
    [{ timeout_seconds: "30" }, "expected an integer"],
    [{ timeout_seconds: null }, "expected an integer"],
    [{ timeout_seconds: 121 }, "expected an integer"],
    [{ max_depth: [8] }, "expected an integer"],
    [{ max_depth: null }, "expected an integer"],
    [{ max_depth: 13 }, "expected an integer"],
    [{ include_menus: "false" }, "must be boolean"],
    [{ include_menus: null }, "must be boolean"],
  ]) {
    await expectReject(() => manager.operateApplication({
      application: "Example", action: "set_value", selector: { role: "AXTextField" }, value_resource: "account-secret", ...invalidArgs,
    }), expected);
  }
  assert(resourceReads.length === resourceReadsBeforeMalformedMetadata,
    "malformed application execution metadata triggered a secret resource read before full preflight");

  const callsBeforeIgnoredValue = calls.length;
  const readsBeforeIgnoredValue = resourceReads.length;
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" }, value_resource: "account-secret",
  }), "does not accept value or value_resource");
  assert(calls.length === callsBeforeIgnoredValue, "non-text application action reached JXA after receiving an ignored value_resource");
  assert(resourceReads.length === readsBeforeIgnoredValue, "non-text application action resolved a sensitive resource before rejecting it");
  const callsBeforeMissingKeystroke = calls.length;
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "keystroke", selector: { role: "AXTextField" },
  }), "requires value or value_resource");
  assert(calls.length === callsBeforeMissingKeystroke, "keystroke without a value reached JXA before validation");
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value: "",
  }), "requires non-empty text");
  assert(calls.length === callsBeforeMissingKeystroke, "empty direct keystroke reached JXA before validation");
  const readsBeforeEmptyResource = resourceReads.length;
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value_resource: "empty-text",
  }), "requires non-empty text");
  assert(resourceReads.length === readsBeforeEmptyResource + 1 && calls.length === callsBeforeMissingKeystroke,
    "empty resource keystroke did not fail after resource resolution but before JXA mutation");
  const keystroke = await manager.operateApplication({
    application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value: "中文😀x",
  });
  const keystrokePayload = JSON.parse(calls.at(-1).stdin);
  const keystrokeDispatch = keyboardCalls.at(-1);
  assert(keystroke.input_transport === "public-cgevent-pid", "application keystroke lost PID-scoped keyboard transport provenance");
  assert(keystroke.focus_prepared === true, "application keystroke lost deterministic AX focus-preparation provenance");
  assert(keystrokePayload.action === "focus" && keystrokePayload.value === null
    && keystrokePayload.includeProcessGeneration === true && keystroke.value_exposed === false,
  "application keystroke leaked text into the Accessibility preparation helper or exposed the submitted value");
  assert(keystrokeDispatch?.action === "keystroke" && keystrokeDispatch.args.text === "中文😀x"
    && keystrokeDispatch.args.pid === 987 && keystrokeDispatch.args.process_generation === "gen-987",
  "application keystroke did not bind the native PID keyboard dispatch to the prepared process generation");
  assert(Object.hasOwn(keystroke, "process_id") === false && Object.hasOwn(keystroke, "process_generation") === false,
    "application keystroke exposed its private process-generation handoff");
  const callsBeforeInvalidKeyPress = calls.length;
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "key_press", selector: { role: "AXTextField" },
  }), "requires key");
  await expectReject(() => manager.operateApplication({
    application: "Example", action: "key_press", selector: { role: "AXTextField" }, key: "Meta+A",
  }), "supports Enter, Tab, Escape");
  assert(calls.length === callsBeforeInvalidKeyPress, "invalid application key_press reached JXA before validation");
  const keyPress = await manager.operateApplication({
    application: "Example", action: "key_press", selector: { role: "AXTextField" }, key: "Shift+Tab",
  });
  const keyPressPayload = JSON.parse(calls.at(-1).stdin);
  const keyPressDispatch = keyboardCalls.at(-1);
  assert(keyPress.input_transport === "public-cgevent-pid", "application key_press lost PID-scoped keyboard transport provenance");
  assert(keyPress.focus_prepared === true, "application key_press lost deterministic AX focus-preparation provenance");
  assert(keyPressPayload.action === "focus" && keyPressPayload.key === null && keyPressPayload.value === null,
    "application key_press leaked special-key dispatch into the Accessibility preparation helper");
  assert(keyPressDispatch?.action === "key_press" && keyPressDispatch.args.key === "Shift+Tab"
    && keyPressDispatch.args.pid === 987 && keyPressDispatch.args.process_generation === "gen-987",
  "application key_press did not bind the native PID keyboard dispatch to the prepared process generation");
  const activated = await manager.operateApplication({ application: "Example", action: "activate" });
  const activatedPayload = JSON.parse(calls.at(-1).stdin);
  assert(activated.ok === true && activatedPayload.selector === null, "activate incorrectly required a UI selector");
  assert(activatedPayload.includeProcessGeneration === true,
    "ordinary application mutation did not bind its last-hop JXA settlement to a process generation");
  assert(activatedPayload.includeMenus === false, "application actions expanded menu trees by default");
  await manager.inspectApplication({ application: "Example", include_menus: true });
  assert(JSON.parse(calls.at(-1).stdin).includeMenus === true, "include_menus was not forwarded to the fixed JXA helper");
  assert(JSON.parse(calls.at(-1).stdin).includeGeometry === false, "ordinary application inspection unexpectedly paid the AX geometry IPC cost");
  await manager.inspectApplication({ application: "Example", include_geometry: true });
  assert(JSON.parse(calls.at(-1).stdin).includeGeometry === true, "Computer Use geometry opt-in was not forwarded to the fixed JXA helper");
  const publicInspect = await manager.inspectApplication({ application: "Example" });
  assert(Object.hasOwn(publicInspect, "process_id") === false && Object.hasOwn(publicInspect, "_machine_process_id") === false,
    "low-level application inspection exposed the process identity without an internal opt-in");
  const authorityValidationCallCount = calls.length;
  await expectReject(
    () => manager.inspectApplication({ application: "Example", expected_process_id: "987" }),
    "expected_process_id must be a positive integer",
  );
  await expectReject(
    () => manager.inspectApplication({ application: "Example", expected_process_generation: ["gen-987"] }),
    "expected_process_generation is invalid",
  );
  assert(calls.length === authorityValidationCallCount,
    "coercible application process authority reached the fixed JXA helper");
  const internalInspect = await manager.inspectApplication({
    application: "Example", include_process_id: true, include_window_state: true, expected_process_id: 987,
  });
  assert(internalInspect._machine_process_id === 987 && internalInspect._machine_process_generation === "gen-987"
    && Object.hasOwn(internalInspect, "process_id") === false && Object.hasOwn(internalInspect, "process_generation") === false
    && Object.hasOwn(internalInspect, "window_state") === false,
  "internal application inspection did not project the private process instance identity safely");
  assert(internalInspect._machine_window_state_checked === true, "inline post-AX window-state check was not marked complete");
  assert(JSON.stringify(internalInspect._machine_window) === JSON.stringify({
    id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    process_id: 987,
    process_generation: "gen-987",
  }), "inline post-AX window state was not projected into the private selected-window binding");
  const internalInspectPayload = JSON.parse(calls.at(-1).stdin);
  assert(internalInspectPayload.expectedProcessId === 987, "expected application pid was not forwarded to fixed JXA inspection");
  const verifyAuthorityCallCount = calls.length;
  await expectReject(() => manager.verifyApplicationValue({
    application: "Example", selector: { role: "AXTextField" }, value: ["local-secret"],
  }), "application verification value must be a string");
  assert(calls.length === verifyAuthorityCallCount, "coercible application verification value reached JXA");
  assert(internalInspectPayload.includeWindowState === true, "inline post-AX window-state request was not forwarded to fixed JXA inspection");
  await manager.operateApplication({ application: "Example", action: "check", selector: { role: "AXCheckBox" } });
  assert(JSON.parse(calls.at(-1).stdin).action === "check", "application check was not forwarded to the fixed JXA helper");
  await manager.operateApplication({ application: "Example", action: "uncheck", selector: { role: "AXCheckBox" } });
  assert(JSON.parse(calls.at(-1).stdin).action === "uncheck", "application uncheck was not forwarded to the fixed JXA helper");
  const activatedByPath = await manager.operateApplication({ application: join(applications, "Example.app"), action: "activate" });
  assert(activatedByPath.process_name === "Example" && JSON.parse(calls.at(-1).stdin).application === "Example", "application bundle path was not normalized to its process name");

  const operated = await manager.operateApplication({
    application: "Example",
    action: "set_value",
    selector: { role: "AXTextField", index: 0 },
    value_resource: "account-secret",
    retain_value_verification: true,
  });
  assert(operated.value_source === "local-resource" && operated.value_exposed === false, "application resource injection exposed the value");
  assert(/^av_[A-Za-z0-9_-]{24,80}$/.test(operated._machine_value_verification_handle || ""), "set_value did not retain an opaque verification handle");
  const malformedHandleCallCount = calls.length;
  await expectReject(() => manager.verifyApplicationValue({
    application: "Example", selector: { role: "AXTextField", index: 0 },
    value_verification_handle: [operated._machine_value_verification_handle],
  }), "application value verification handle is invalid");
  assert(calls.length === malformedHandleCallCount,
    "coercible application verification handle reached JXA or consumed the retained value");
  await expectReject(async () => manager.retainApplicationValue(["coercible-secret"]),
    "retained verification value must be a string");
  const jxa = calls.at(-1);
  assert(jxa.cmd === "osascript" && jxa.argv.includes("JavaScript"), "application UI operation did not use fixed JXA");
  const fixedJxaSource = String(jxa.argv.at(-1) || "");
  assert(fixedJxaSource.includes("function systemEventsRead(operation)")
    && fixedJxaSource.includes("function applicationProcessExists(process)")
    && fixedJxaSource.includes("function applicationProcessId(process)")
    && fixedJxaSource.includes("Number(error && error.errorNumber) === -1743")
    && fixedJxaSource.includes("typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId < 1")
    && fixedJxaSource.includes("typeof copied !== 'number' || copied !== PROC_BSDINFO_SIZE")
    && fixedJxaSource.includes("typeof signature !== 'string' || !signature")
    && fixedJxaSource.includes("values.every((item) => typeof item === 'number' && Number.isFinite(item))")
    && fixedJxaSource.includes("typeof selector[key] !== 'string' || typeof item[key] !== 'string'")
    && fixedJxaSource.includes("typeof actual !== 'string'")
    && fixedJxaSource.includes("matched: actual === payload.value")
    && fixedJxaSource.includes("typeof a === 'number' && Number.isFinite(a)")
    && fixedJxaSource.includes("cgWindowsForProcess(processId)"),
  "fixed JXA lost explicit System Events Automation denial classification or single-read process identity reuse");
  assert(!fixedJxaSource.includes("safe(() => process.unixId(), 0)")
    && !fixedJxaSource.includes("safe(() => process.exists(), false)")
    && !fixedJxaSource.includes("const processId = Number(raw)")
    && !fixedJxaSource.includes("Number($.proc_pidinfo")
    && !fixedJxaSource.includes("String(ObjC.unwrap(start.base64EncodedStringWithOptions")
    && !fixedJxaSource.includes("String(actual) === String(payload.value)")
    && !fixedJxaSource.includes("String(item[key] || '')")
    && !fixedJxaSource.includes("Number(position[0])")
    && !fixedJxaSource.includes("Math.abs(Number(a) - Number(b))"),
  "fixed JXA still hides System Events Automation denial behind a safe-read fallback");
  assert(jxa.stdin.includes("local-secret"), "application resource value was not delivered locally");
  assert(!JSON.stringify(operated).includes("local-secret"), "application action returned a local resource value");
  assert(resourceReads.includes("account-secret"), "set_value did not resolve its registered resource inside AppAutomation");

  const directValue = await manager.operateApplication({
    application: "Example",
    action: "set_value",
    selector: { role: "AXTextField", index: 0 },
    value: "immutable-direct-value",
    retain_value_verification: true,
  });
  assert(Object.hasOwn(directValue, "_machine_value_verification_handle") === false,
    "direct immutable set_value allocated retained-value state despite not using a resource alias");

  await manager.operateApplication({
    application: "Example",
    action: "focus",
    selector: { identifier: "save" },
    expected_process_id: 987,
    expected_process_generation: "gen-987",
    expected_window_bounds: { x: 10, y: 20, width: 640, height: 480 },
    expected_element_bounds: { x: 100, y: 120, width: 80, height: 30 },
  });
  const guardedPayload = JSON.parse(calls.at(-1).stdin);
  assert(JSON.stringify(guardedPayload.expectedWindowBounds) === JSON.stringify({ x: 10, y: 20, width: 640, height: 480 }),
    "snapshot-bound application action did not forward its expected owner-window bounds");
  assert(JSON.stringify(guardedPayload.expectedElementBounds) === JSON.stringify({ x: 100, y: 120, width: 80, height: 30 }),
    "snapshot-bound application action did not forward its expected element geometry");
  assert(guardedPayload.expectedProcessId === 987 && guardedPayload.expectedProcessGeneration === "gen-987",
    "snapshot-bound application action did not forward its expected process instance identity");

  const verifiedValue = await manager.verifyApplicationValue({
    application: "Example",
    selector: { role: "AXTextField", index: 0 },
    value_verification_handle: operated._machine_value_verification_handle,
    expected_process_id: 987,
    expected_process_generation: "gen-987",
    expected_window_bounds: { x: 10, y: 20, width: 640, height: 480 },
    expected_element_bounds: { x: 100, y: 120, width: 80, height: 30 },
  });
  const verificationPayload = JSON.parse(calls.at(-1).stdin);
  assert(verificationPayload.operation === "verify_value", "private application value verification did not use the fixed JXA operation");
  assert(verificationPayload.expectedProcessId === 987 && verificationPayload.expectedProcessGeneration === "gen-987",
    "private application value verification dropped the post-snapshot process instance identity");
  assert(verificationPayload.value === "local-secret", "registered resource was not resolved inside AppAutomation for private comparison");
  assert(verifiedValue.supported === true && verifiedValue.matched === true, "private application value comparison result was not projected");
  assert(verifiedValue.value_source === "retained-action-value", "value verification did not consume the exact retained action value");
  assert(!JSON.stringify(verifiedValue).includes("local-secret"), "private application value comparison leaked the expected value");
  await expectReject(() => manager.verifyApplicationValue({
    application: "Example",
    selector: { role: "AXTextField", index: 0 },
    value_verification_handle: operated._machine_value_verification_handle,
  }), "missing or expired");

  const discardedValue = await manager.operateApplication({
    application: "Example",
    action: "set_value",
    selector: { role: "AXTextField", index: 0 },
    value_resource: "account-secret",
    retain_value_verification: true,
  });
  assert(manager.discardApplicationValueVerification([discardedValue._machine_value_verification_handle]) === false,
    "coercible verification handle deleted retained private comparison state");
  assert(manager.discardApplicationValueVerification(discardedValue._machine_value_verification_handle) === true,
    "explicit value verification cleanup did not remove the retained exact value");
  assert(manager.discardApplicationValueVerification(discardedValue._machine_value_verification_handle) === false,
    "value verification cleanup was not idempotent");
  await expectReject(() => manager.verifyApplicationValue({
    application: "Example",
    selector: { role: "AXTextField", index: 0 },
    value_verification_handle: discardedValue._machine_value_verification_handle,
  }), "missing or expired");

  const ttlHandle = manager.retainApplicationValue("ttl-private-value");
  applicationClock += 60_001;
  await expectReject(async () => manager.takeApplicationValue(ttlHandle), "missing or expired");
  assert(![...manager.valueVerificationStore.values()].some((entry) => entry?.value === "ttl-private-value"),
    "expired exact application value remained in memory after the monotonic TTL elapsed");

  const liveSensitive = await manager.operateApplication({
    application: "Example",
    action: "set_value",
    selector: { identifier: "secure" },
    value_resource: "account-secret",
    retain_value_verification: true,
  });
  assert(Object.hasOwn(liveSensitive, "_machine_value_verification_handle") === false,
    "set_value retained an exact-value handle after the live dispatch target became sensitive");

  let unfocusedKeyboardDispatches = 0;
  const unfocusedKeyboard = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    backgroundInputService: {
      async keystroke() { unfocusedKeyboardDispatches += 1; return { ok: true, dispatch_started: true, input_transport: "public-cgevent-pid" }; },
      async keyPress() { unfocusedKeyboardDispatches += 1; return { ok: true, dispatch_started: true, input_transport: "public-cgevent-pid" }; },
    },
    runProcess: async () => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true, matched: 1, selected_index: 0, element: { focused: false, sensitive: false },
        process_id: 987, process_generation: "gen-987",
      }),
      stderr: "",
    }),
  });
  await expectReject(() => unfocusedKeyboard.operateApplication({
    application: "Example", action: "keystroke", selector: { role: "AXTextField" }, value: "never-posted",
  }), "could not become focused before dispatch");
  assert(unfocusedKeyboardDispatches === 0,
    "application keyboard native helper ran even though AX focus preparation was not confirmed");

  let lostJxaOptions = null;
  let lostJxaAllowFailure = null;
  const lostJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async (...args) => {
      lostJxaAllowFailure = args[3];
      lostJxaOptions = args.at(-1);
      throw new BridgeError("execution_failed", "osascript response lost after application mutation", {
        details: {
          reason: "process_outcome_unknown_after_spawn", trigger: "process_error",
          side_effects_started: "unknown", termination_requested: false, effect_settlement: "unknown",
        },
      });
    },
  });
  const lostJxaError = await captureError(() => lostJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }));
  const lostJxaPublic = publicError(lostJxaError);
  assert(lostJxaPublic.message.includes("application Accessibility mutation may have been partially dispatched")
    && lostJxaPublic.retryable === false,
  "ambiguous Accessibility mutation was hidden or advertised as retryable at the direct MCP boundary");
  assert(lostJxaPublic.details?.side_effects_started === "unknown"
    && lostJxaPublic.details?.termination_requested === false
    && lostJxaPublic.details?.effect_settlement === "unknown",
  "direct application settlement dropped structured post-spawn uncertainty metadata");
  assert(lostJxaAllowFailure === true && lostJxaOptions?.nonReplayableMutation === true,
    "mutating Accessibility dispatch did not preserve post-spawn settlement information from osascript");

  const nonzeroMutationJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 1, stdout: "", stderr: "osascript exited after spawn" }),
  });
  await expectReject(() => nonzeroMutationJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }), "application Accessibility mutation may have been partially dispatched; the action outcome is unknown");

  const definitePreSpawnJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => { throw new BridgeError("policy_denied", "osascript blocked before spawn"); },
  });
  const definitePreSpawnJxaError = await captureError(() => definitePreSpawnJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }));
  assert(definitePreSpawnJxaError?.code === "policy_denied" && definitePreSpawnJxaError?.message === "osascript blocked before spawn",
    "definite pre-spawn Accessibility failure was incorrectly upgraded to an unknown application effect");

  const deniedAutomationJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({
      code: 0,
      stdout: JSON.stringify({ error: "macOS Automation permission to control System Events is required" }),
      stderr: "",
    }),
  });
  for (const operation of [
    () => deniedAutomationJxa.inspectApplication({ application: "Example", include_process_id: true }),
    () => deniedAutomationJxa.operateApplication({ application: "Example", action: "click", selector: { role: "AXButton" } }),
  ]) {
    const deniedAutomationError = await captureError(operation);
    assert(deniedAutomationError?.code === "permission_denied"
      && deniedAutomationError?.retryable === false
      && deniedAutomationError?.details?.reason === "macos_system_events_automation_permission_required",
    "System Events Automation denial was not preserved as a definite pre-dispatch permission failure");
  }

  for (const malformedSettlement of [
    { error: ["macOS Automation permission to control System Events is required"] },
    { error: "" },
    [],
  ]) {
    const malformedJxa = new AppAutomationManager({
      policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
      platform: "darwin", home: root, applicationRoots: [applications], displayPath: (value) => value,
      readResourceText: async () => "",
      runProcess: async () => ({ code: 0, stdout: JSON.stringify(malformedSettlement), stderr: "" }),
    });
    const mutationError = await captureError(() => malformedJxa.operateApplication({
      application: "Example", action: "click", selector: { role: "AXButton" },
    }));
    assert(publicError(mutationError).message.includes("application Accessibility mutation may have been partially dispatched")
      && publicError(mutationError).retryable === false,
    "malformed Accessibility mutation settlement was downgraded to a definite/retryable failure");

    const readError = await captureError(() => malformedJxa.inspectApplication({ application: "Example", include_process_id: true }));
    assert(/invalid (?:error )?settlement/.test(readError?.message || ""),
      "malformed read-only Accessibility settlement was accepted or coerced into a typed helper error");
  }

  const failedSpawnJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => { throw new BridgeError("execution_failed", "spawn /private/tmp/mbm-jxa-secret ENOENT", {
      details: { reason: "process_failed_before_spawn" },
    }); },
  });
  const failedSpawnJxaError = await captureError(() => failedSpawnJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }));
  assert(failedSpawnJxaError?.code === "unavailable"
    && failedSpawnJxaError?.details?.reason === "application_accessibility_helper_unavailable_before_dispatch"
    && !String(failedSpawnJxaError?.message).includes("/private/tmp"),
  "pre-spawn Accessibility helper failure leaked private launch details or lost definite settlement");

  const malformedMutationJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "not-json", stderr: "" }),
  });
  await expectReject(() => malformedMutationJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }), "application Accessibility mutation may have been partially dispatched; the action outcome is unknown");

  const incompleteMutationJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  });
  await expectReject(() => incompleteMutationJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }), "application Accessibility mutation may have been partially dispatched; the action outcome is unknown");

  const explicitPreflightJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: JSON.stringify({ error: "no UI element matched selector" }), stderr: "" }),
  });
  const explicitPreflightError = await captureError(() => explicitPreflightJxa.operateApplication({
    application: "Example", action: "click", selector: { role: "AXButton" },
  }));
  assert(String(explicitPreflightError.message).includes("no UI element matched selector"), "explicit JXA preflight detail was lost internally");
  assert(publicError(explicitPreflightError).message === "operation failed",
    "ordinary Accessibility preflight detail was exposed while typing mutation-only settlement errors");

  let cancelledAfterResourceRead = false;
  let cancelledMutationRuns = 0;
  const cancelledJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => { cancelledAfterResourceRead = true; return "secret"; },
    throwIfCancelled: () => { if (cancelledAfterResourceRead) throw new Error("application request cancelled"); },
    runProcess: async () => { cancelledMutationRuns += 1; return { code: 0, stdout: "{}", stderr: "" }; },
  });
  await expectReject(() => cancelledJxa.operateApplication({
    application: "Example", action: "set_value", selector: { role: "AXTextField" }, value_resource: "account-secret",
  }), "application request cancelled");
  assert(cancelledMutationRuns === 0, "application mutation process started after cancellation arrived during resource resolution");

  let launchCancellationChecks = 0;
  let cancelledLaunchRuns = 0;
  const cancelledLaunch = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    throwIfCancelled: () => {
      launchCancellationChecks += 1;
      if (launchCancellationChecks > 1) throw new Error("application launch cancelled before invocation");
    },
    runProcess: async () => { cancelledLaunchRuns += 1; return { code: 0, stdout: "", stderr: "" }; },
  });
  await expectReject(() => cancelledLaunch.openApplication({ application: "Example" }),
    "application launch cancelled before invocation");
  assert(cancelledLaunchRuns === 0, "OS launcher process started after cancellation was observed at the final pre-launch boundary");

  const blockedLaunch = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => { throw new BridgeError("policy_denied", "launcher blocked before spawn"); },
  });
  await expectReject(() => blockedLaunch.openApplication({ application: "Example" }), "launcher blocked before spawn");

  const failedSpawnLaunch = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => { throw new BridgeError("execution_failed", "spawn /private/tmp/mbm-launch-secret ENOENT", {
      details: { reason: "process_failed_before_spawn" },
    }); },
  });
  const failedSpawnLaunchError = await captureError(() => failedSpawnLaunch.openApplication({ application: "Example" }));
  assert(failedSpawnLaunchError?.code === "unavailable"
    && failedSpawnLaunchError?.details?.reason === "application_launch_unavailable_before_dispatch"
    && !String(failedSpawnLaunchError?.message).includes("/private/tmp"),
  "pre-spawn application launcher failure leaked private launch details or lost definite settlement");

  let lostLaunchOptions = null;
  const lostLaunch = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async (_cmd, _argv, _timeout, _allowFailure, _maxOutput, _context, _cwd, _stdin, options = {}) => {
      lostLaunchOptions = options;
      throw new BridgeError("execution_failed", "launcher response lost after spawn", {
        details: { reason: "process_outcome_unknown_after_spawn", trigger: "process_error" },
      });
    },
  });
  const lostLaunchError = await captureError(() => lostLaunch.openApplication({ application: "Example" }));
  assert(lostLaunchOptions?.nonReplayableMutation === true,
    "ambiguous application launch did not request process-level non-replayable settlement");
  assert(publicError(lostLaunchError).message.includes("application launch may have been partially dispatched")
    && publicError(lostLaunchError).retryable === false,
  "ambiguous application launch was hidden or advertised as retryable at the direct MCP boundary");

  const silentJxa = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await expectReject(() => silentJxa.inspectApplication({ application: "Example" }), "returned no JSON output");

  const restricted = new AppAutomationManager({
    policy: { profile: "agent", execMode: "direct", unrestrictedPaths: false },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await expectReject(() => restricted.openApplication({ application: "Example" }), "disabled by the active policy");

  const linuxApplications = join(root, "linux-applications");
  await mkdir(linuxApplications, { recursive: true });
  await writeFile(join(linuxApplications, "Example.desktop"), "[Desktop Entry]\nName=Example\nExec=example\nType=Application\n", "utf8");
  const linuxCalls = [];
  const linux = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "linux",
    home: root,
    applicationRoots: [linuxApplications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async (cmd, argv) => {
      linuxCalls.push({ cmd, argv });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const linuxListed = await linux.listApplications({ query: "example" });
  assert(linuxListed.applications.length === 1, "Linux desktop application discovery failed");
  await linux.openApplication({ application: "Example", target: "https://example.test/" });
  assert(linuxCalls.at(-1).cmd === "gio" && linuxCalls.at(-1).argv[0] === "launch" && basename(linuxCalls.at(-1).argv[1]) === "Example.desktop" && linuxCalls.at(-1).argv[2] === "https://example.test/", "Linux desktop launcher did not use gio launch");
  await expectReject(() => linux.inspectApplication({ application: "Example" }), "requires macOS");

  const windowsApplications = join(root, "windows-applications");
  await mkdir(windowsApplications, { recursive: true });
  const windowsExecutable = join(windowsApplications, "O'Brien.exe");
  await writeFile(windowsExecutable, "synthetic", "utf8");
  const windowsCalls = [];
  const windows = new AppAutomationManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    platform: "win32",
    home: root,
    applicationRoots: [windowsApplications],
    displayPath: () => "<application-path>",
    readResourceText: async () => "",
    runProcess: async (cmd, argv) => { windowsCalls.push({ cmd, argv }); return { code: 0, stdout: "", stderr: "" }; },
  });
  const maliciousTarget = "https://example.test/a'; Write-Output pwned; #";
  const windowsOpened = await windows.openApplication({ application: "O'Brien", target: maliciousTarget });
  const powershell = windowsCalls.at(-1);
  const canonicalWindowsExecutable = await realpath(windowsExecutable);
  const expectedScript = `Start-Process -FilePath ${powershellSingleQuotedLiteral(canonicalWindowsExecutable)} -ArgumentList ${powershellSingleQuotedLiteral(maliciousTarget)}`;
  assert(powershell.cmd === "powershell.exe" && powershell.argv.at(-1) === expectedScript, "Windows launcher did not use canonical single-quoted PowerShell literals");
  assert(windowsOpened.resolved_application === "<application-path>", "application launcher leaked its resolved absolute path");

  const routingRuntime = new LocalRuntime({
    workspace: root,
    policy: { profile: "full", origin: "explicit", revision: 3 },
    jobRoot: join(root, "routing-jobs"),
    browserStateRoot: join(root, "routing-browser-state"),
    agentHome: join(root, "routing-home"),
    codexHome: join(root, "routing-codex-home"),
    recoverJobs: false,
    applicationAutomation: {
      platform: "darwin",
      home: root,
      applicationRoots: [applications],
      applicationCacheMs: 0,
    },
  });
  try {
    const routed = await routingRuntime.executeTool("resolve_task_capabilities", {
      path: ".",
      task: "请使用 Late Arrival 完成工作",
    });
    assert(routed.application_matches.some((application) => application.name === "Late Arrival"), "task resolver required generic app wording instead of matching an installed application name");
    assert(routed.recommended_tools.includes("operate_local_application"), "task resolver did not recommend structured application tools for a named application");
    assert(routed.execution_routing?.primary_route?.id === "application", "installed application match did not become the primary execution route");
    assert(routed.execution_routing?.routes?.some((route) => route.id === "shell"), "application routing removed the direct shell escape hatch");

    const reviewerRouted = await routingRuntime.executeTool("resolve_task_capabilities", {
      path: ".",
      task: "Use Late Arrival and the browser to complete this task",
    }, {
      origin: "relay",
      authorization: {
        account_id: `acct_${"A".repeat(32)}`,
        account_version: 1,
        client_id: `mcp_client_${"B".repeat(43)}`,
        family_id: `mcp_family_${"C".repeat(43)}`,
        role: "reviewer",
      },
    });
    assert(reviewerRouted.application_matches.length === 0 && reviewerRouted.browser_backend === null,
      "reviewer task resolution leaked application discovery or browser metadata from the daemon's full policy");
    assert(!reviewerRouted.execution_routing.routes.some((route) => ["application", "browser", "shell"].includes(route.id)),
      "reviewer task resolution recommended execution surfaces outside the account's effective policy");
  } finally {
    routingRuntime.stop();
  }

  const liveMacosRequested = process.argv.includes("--live-macos");
  if (liveMacosRequested && process.platform !== "darwin") throw new Error("--live-macos requires macOS");
  if (liveMacosRequested) await liveMacosCalculatorSmoke(root);

  console.log("application automation test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function expectReject(callback, expected) {
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}

async function captureError(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected operation to reject");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function liveMacosCalculatorSmoke(root) {
  const runtime = new LocalRuntime({
    workspace: root,
    policy: { profile: "full", origin: "explicit", revision: 3 },
    jobRoot: join(root, "live-jobs"),
    browserStateRoot: join(root, "live-browser-state"),
    recoverJobs: false,
  });
  try {
    const opened = await runtime.executeTool("open_local_application", { application: "Calculator", timeout_seconds: 30 });
    assert(opened.code === 0, "live Calculator open failed");
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1000); });
    const activated = await runtime.executeTool("operate_local_application", { application: "Calculator", action: "activate", timeout_seconds: 30 });
    assert(activated.ok === true, "live Calculator activation did not return structured success");
    const inspected = await runtime.executeTool("inspect_local_application", { application: "Calculator", max_depth: 6, max_elements: 300, include_values: true, timeout_seconds: 60 });
    assert(Array.isArray(inspected.elements) && inspected.elements.some((item) => item.identifier === "One"), "live Calculator inspection did not reach main-window controls");
    assert(inspected.menus_included === false, "live Calculator inspection expanded menu trees by default");
    const clicked = await runtime.executeTool("operate_local_application", { application: "Calculator", action: "click", selector: { identifier: "One" }, timeout_seconds: 30 });
    assert(clicked.ok === true && clicked.element?.identifier === "One", "live Calculator click failed");
  } finally {
    await runtime.stop();
    spawnSync("osascript", ["-e", "tell application \"Calculator\" to quit"], { stdio: "ignore" });
  }
}
