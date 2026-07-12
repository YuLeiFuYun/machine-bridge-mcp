import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppAutomationManager } from "../src/local/app-automation.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-app-automation-"));
const applications = join(root, "Applications");
await mkdir(join(applications, "Example.app"), { recursive: true });
await mkdir(join(applications, "Utilities", "Nested Utility.app"), { recursive: true });
const calls = [];
const manager = new AppAutomationManager({
  policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
  platform: "darwin",
  home: root,
  applicationRoots: [applications],
  displayPath: (value) => value,
  readResourceText: async (name) => name === "account-secret" ? "local-secret" : "",
  runProcess: async (cmd, argv, timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv, timeoutMs, stdin });
    if (cmd === "osascript") return { code: 0, stdout: JSON.stringify({ ok: true, matched: 1 }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  },
});
try {
  const listed = await manager.listApplications({ query: "example" });
  assert(listed.applications.length === 1 && listed.applications[0].name === "Example", "macOS application discovery failed");
  const nested = await manager.listApplications({ query: "nested utility" });
  assert(nested.applications.length === 1 && nested.applications[0].name === "Nested Utility", "nested macOS application discovery failed");
  assert(listed.capabilities.arbitrary_script_execution === false, "application capabilities claim arbitrary script support");

  const opened = await manager.openApplication({ application: "Example", target: "https://example.test/" });
  assert(opened.code === 0 && calls.at(-1).cmd === "open", "application launcher did not use the macOS launcher");
  assert(JSON.stringify(calls.at(-1).argv) === JSON.stringify(["-a", "Example", "https://example.test/"]), "application launcher arguments are incorrect");

  await expectReject(() => manager.operateApplication({ application: "Example", action: "set_value", selector: { role: "AXTextField" }, value: "bad\0value" }), "contains a NUL byte");
  const activated = await manager.operateApplication({ application: "Example", action: "activate" });
  assert(activated.ok === true && JSON.parse(calls.at(-1).stdin).selector === null, "activate incorrectly required a UI selector");
  const activatedByPath = await manager.operateApplication({ application: join(applications, "Example.app"), action: "activate" });
  assert(activatedByPath.process_name === "Example" && JSON.parse(calls.at(-1).stdin).application === "Example", "application bundle path was not normalized to its process name");

  const operated = await manager.operateApplication({
    application: "Example",
    action: "set_value",
    selector: { role: "AXTextField", index: 0 },
    value_resource: "account-secret",
  });
  assert(operated.value_source === "local-resource" && operated.value_exposed === false, "application resource injection exposed the value");
  const jxa = calls.at(-1);
  assert(jxa.cmd === "osascript" && jxa.argv.includes("JavaScript"), "application UI operation did not use fixed JXA");
  assert(jxa.stdin.includes("local-secret"), "application resource value was not delivered locally");
  assert(!JSON.stringify(operated).includes("local-secret"), "application action returned a local resource value");

  const restricted = new AppAutomationManager({
    policy: { profile: "agent", execMode: "direct", unrestrictedPaths: false },
    platform: "darwin",
    home: root,
    applicationRoots: [applications],
    displayPath: (value) => value,
    readResourceText: async () => "",
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await expectReject(() => restricted.openApplication({ application: "Example" }), "requires the canonical full profile");

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
  assert(linuxCalls.at(-1).cmd === "gio" && linuxCalls.at(-1).argv[0] === "launch" && linuxCalls.at(-1).argv[1].endsWith("/Example.desktop") && linuxCalls.at(-1).argv[2] === "https://example.test/", "Linux desktop launcher did not use gio launch");
  await expectReject(() => linux.inspectApplication({ application: "Example" }), "requires macOS");

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
