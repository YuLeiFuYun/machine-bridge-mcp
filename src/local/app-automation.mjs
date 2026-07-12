import { opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const MAX_APPLICATIONS = 1000;
const MAX_APPLICATION_SCAN_ENTRIES = 20_000;
const MAX_APPLICATION_SCAN_DEPTH = 3;
const MAX_UI_ELEMENTS = 500;
const MAX_UI_DEPTH = 12;
const MAX_TEXT_CHARS = 4000;
const APP_NAME_PATTERN = /^[^\0\r\n]{1,300}$/;

export class AppAutomationManager {
  constructor({ policy, displayPath, runProcess, readResourceText, throwIfCancelled = () => {}, platform = process.platform, home = homedir(), applicationRoots = null }) {
    this.policy = policy || {};
    this.displayPath = displayPath;
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.throwIfCancelled = throwIfCancelled;
    this.platform = platform;
    this.home = home;
    this.applicationRoots = applicationRoots;
  }

  capabilities() {
    return {
      platform: this.platform,
      discovery: true,
      open: true,
      accessibility_inspection: this.platform === "darwin",
      structured_accessibility_actions: this.platform === "darwin",
      arbitrary_script_execution: false,
      permission_note: this.platform === "darwin"
        ? "UI inspection and actions require macOS Accessibility permission for the Machine Bridge runtime."
        : "Structured UI inspection currently requires macOS; application discovery and opening remain cross-platform.",
    };
  }

  async listApplications(args = {}, context = {}) {
    this.throwIfCancelled(context);
    const query = String(args.query || "").trim().toLowerCase();
    const limit = clampInt(args.max_results, 200, 1, MAX_APPLICATIONS);
    const discovery = await this.discoverApplications(context);
    const matched = discovery.applications
      .filter((item) => !query || `${item.name}\n${item.id}\n${item.path}`.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name));
    const filtered = matched
      .slice(0, limit)
      .map((item) => ({ ...item, path: item.path ? this.displayPath(item.path) : "" }));
    return {
      platform: this.platform,
      applications: filtered,
      truncated: discovery.truncated || matched.length > limit,
      scanned_entries: discovery.visitedEntries,
      capabilities: this.capabilities(),
    };
  }

  async discoverApplications(context = {}) {
    if (this.platform === "darwin") {
      return listMacApplications(this.applicationRoots || ["/Applications", "/System/Applications", join(this.home, "Applications")], context, this.throwIfCancelled);
    }
    if (this.platform === "win32") return listWindowsApplications(this.applicationRoots, this.home, context, this.throwIfCancelled);
    return listLinuxApplications(this.applicationRoots, this.home, context, this.throwIfCancelled);
  }

  async resolveApplicationReference(application, context = {}) {
    if (application.includes("/") || application.includes("\\")) return application;
    const lower = application.toLowerCase();
    const match = (await this.discoverApplications(context)).applications.find((item) => item.name.toLowerCase() === lower || item.id.toLowerCase() === lower);
    return match?.id || application;
  }

  async openApplication(args = {}, context = {}) {
    this.assertFull("open_local_application");
    const application = requiredApplication(args.application);
    const target = optionalString(args.target, "target", 32768);
    this.throwIfCancelled(context);
    const resolvedApplication = this.platform === "darwin" ? application : await this.resolveApplicationReference(application, context);
    let command;
    if (this.platform === "darwin") {
      const argv = ["-a", application];
      if (args.background === true) argv.push("-g");
      if (target) argv.push(target);
      command = { cmd: "open", argv };
    } else if (this.platform === "win32") {
      const escaped = resolvedApplication.replace(/'/g, "''");
      const targetFragment = target ? ` -ArgumentList '${target.replace(/'/g, "''")}'` : "";
      command = { cmd: "powershell.exe", argv: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${escaped}'${targetFragment}`] };
    } else if (resolvedApplication.toLowerCase().endsWith(".desktop")) {
      command = { cmd: "gio", argv: ["launch", resolvedApplication, ...(target ? [target] : [])] };
    } else {
      command = target
        ? { cmd: resolvedApplication, argv: [target] }
        : { cmd: resolvedApplication, argv: [] };
    }
    const result = await this.runProcess(command.cmd, command.argv, clampInt(args.timeout_seconds, 30, 1, 120) * 1000, false, 256 * 1024, context, undefined, null);
    return { application, resolved_application: resolvedApplication, target, platform: this.platform, ...result };
  }

  async inspectApplication(args = {}, context = {}) {
    this.assertFull("inspect_local_application");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const payload = {
      operation: "inspect",
      application: processName,
      maxDepth: clampInt(args.max_depth, 6, 1, MAX_UI_DEPTH),
      maxElements: clampInt(args.max_elements, 200, 1, MAX_UI_ELEMENTS),
      includeValues: args.include_values === true,
      includeMenus: args.include_menus === true,
    };
    const result = await this.runJxa(payload, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return {
      application,
      process_name: processName,
      platform: this.platform,
      accessibility_permission_required: true,
      ...result,
    };
  }

  async operateApplication(args = {}, context = {}) {
    this.assertFull("operate_local_application");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const action = normalizeAppAction(args.action);
    const selector = action === "activate" ? null : normalizeUiSelector(args.selector || {});
    let value = args.value === undefined ? null : String(args.value);
    if (args.value_resource !== undefined) {
      if (value !== null) throw new Error("value and value_resource are mutually exclusive");
      value = await this.readResourceText(requiredResourceName(args.value_resource));
    }
    if (value !== null && (value.includes("\0") || value.length > MAX_TEXT_CHARS)) {
      throw new Error(`application action value exceeds ${MAX_TEXT_CHARS} characters or contains a NUL byte`);
    }
    const payload = {
      operation: "act",
      application: processName,
      action,
      selector,
      value,
      maxDepth: clampInt(args.max_depth, 8, 1, MAX_UI_DEPTH),
      maxElements: MAX_UI_ELEMENTS,
      includeMenus: args.include_menus === true,
    };
    const result = await this.runJxa(payload, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return {
      application,
      process_name: processName,
      action,
      selector,
      value_source: args.value_resource !== undefined ? "local-resource" : value === null ? "none" : "mcp-argument",
      value_exposed: false,
      ...result,
    };
  }

  async runJxa(payload, timeoutSeconds, context) {
    const input = `${JSON.stringify(payload)}\n`;
    const result = await this.runProcess(
      "osascript",
      ["-l", "JavaScript", "-e", MACOS_UI_JXA],
      timeoutSeconds * 1000,
      false,
      1024 * 1024,
      context,
      undefined,
      input,
    );
    const output = result.stdout.trim();
    if (!output) throw new Error("macOS accessibility helper returned no JSON output");
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("macOS accessibility helper returned invalid JSON");
    }
    if (parsed.error) throw new Error(String(parsed.error));
    return parsed;
  }

  assertFull(tool) {
    if (this.policy.profile !== "full" || this.policy.execMode !== "shell" || this.policy.unrestrictedPaths !== true) {
      throw new Error(`${tool} requires the canonical full profile`);
    }
  }
}

async function listMacApplications(roots, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context,
    throwIfCancelled,
    match(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() === ".app"; },
    descend(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() !== ".app"; },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, ".app"), path, kind: "application-bundle" }; },
  });
}

async function listWindowsApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || [
    join(process.env.APPDATA || home, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.ProgramData ? join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs") : "",
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  return listExecutableRoots(roots, new Set([".exe", ".lnk"]), context, throwIfCancelled);
}

async function listLinuxApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || ["/usr/share/applications", "/usr/local/share/applications", join(home, ".local", "share", "applications")];
  return listExecutableRoots(roots, new Set([".desktop"]), context, throwIfCancelled);
}

async function listExecutableRoots(roots, extensions, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context,
    throwIfCancelled,
    match(entry) { return entry.isFile() && extensions.has(extname(entry.name).toLowerCase()); },
    descend(entry) { return entry.isDirectory(); },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, extname(entry.name)), path, kind: "launcher" }; },
  });
}

async function scanApplicationRoots(roots, { context, throwIfCancelled, match, descend, makeItem }) {
  const results = [];
  const seenRoots = new Set();
  let visited = 0;
  for (const inputRoot of roots) {
    const root = await realpath(inputRoot).catch(() => "");
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    const stack = [{ directory: root, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      const handle = await opendir(current.directory).catch(() => null);
      if (!handle) continue;
      for await (const entry of handle) {
        throwIfCancelled(context);
        visited += 1;
        if (visited > MAX_APPLICATION_SCAN_ENTRIES) return { applications: results, truncated: true, visitedEntries: visited };
        const path = join(current.directory, entry.name);
        if (match(entry)) {
          results.push(makeItem(path, entry));
          if (results.length >= MAX_APPLICATIONS) return { applications: results, truncated: true, visitedEntries: visited };
        } else if (current.depth < MAX_APPLICATION_SCAN_DEPTH && descend(entry)) {
          stack.push({ directory: path, depth: current.depth + 1 });
        }
      }
    }
  }
  return { applications: results, truncated: false, visitedEntries: visited };
}

function requiredApplication(value) {
  const application = String(value || "").trim();
  if (!APP_NAME_PATTERN.test(application)) throw new Error("application must be a non-empty name or path without control characters");
  return application;
}

function applicationProcessName(application) {
  const normalized = String(application).replace(/\\/g, "/");
  const leaf = normalized.split("/").pop() || normalized;
  return leaf.toLowerCase().endsWith(".app") ? leaf.slice(0, -4) : application;
}

function normalizeAppAction(value) {
  const action = String(value || "").trim();
  if (!["activate", "click", "set_value", "focus", "press", "keystroke"].includes(action)) {
    throw new Error("action must be one of activate, click, set_value, focus, press, or keystroke");
  }
  return action;
}

function normalizeUiSelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object");
  const allowed = new Set(["role", "subrole", "name", "title", "description", "identifier", "index"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown UI selector field: ${key}`);
  const selector = {};
  for (const key of ["role", "subrole", "name", "title", "description", "identifier"]) {
    if (value[key] !== undefined) selector[key] = optionalString(value[key], `selector.${key}`, 500);
  }
  if (value.index !== undefined) selector.index = clampInt(value.index, 0, 0, MAX_UI_ELEMENTS - 1);
  if (!Object.keys(selector).length) throw new Error("selector requires at least one field");
  return selector;
}

function requiredResourceName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) throw new Error("value_resource is invalid");
  return name;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  return value;
}

function assertMacAccessibility(platform) {
  if (platform !== "darwin") throw new Error("structured application UI automation currently requires macOS");
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`expected an integer from ${min} to ${max}`);
  return Math.min(Math.max(parsed, min), max);
}

const MACOS_UI_JXA = String.raw`
ObjC.import('Foundation');
function readPayload() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return JSON.parse(text);
}
function safe(fn, fallback) { try { const value = fn(); return value === undefined || value === null ? fallback : value; } catch (_) { return fallback; } }
function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 1000);
}
function describe(element, index, includeValues) {
  const item = {
    index,
    role: safe(() => element.role(), ''),
    subrole: safe(() => element.subrole(), ''),
    name: safe(() => element.name(), ''),
    title: safe(() => element.title(), ''),
    description: safe(() => element.description(), ''),
    identifier: safe(() => element.attributes.byName('AXIdentifier').value(), ''),
    enabled: safe(() => element.enabled(), null),
    focused: safe(() => element.focused(), null)
  };
  const identity = [item.role, item.subrole, item.name, item.title, item.description, item.identifier].join(' ').toLowerCase();
  item.sensitive = item.role === 'AXSecureTextField' || /(?:password|passwd|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification|cvc|cvv|security[-_ ]?code|card[-_ ]?number)/.test(identity);
  if (includeValues && !item.sensitive) item.value = scalar(safe(() => element.value(), null));
  return item;
}
function childrenOf(element) { return safe(() => element.uiElements(), []); }
function flatten(root, maxDepth, maxElements, includeValues, includeMenus) {
  const output = [];
  const elements = [];
  const stack = [{ element: root, depth: 0 }];
  while (stack.length && output.length < maxElements) {
    const current = stack.pop();
    const children = childrenOf(current.element);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      const item = describe(child, output.length, includeValues);
      elements.push(child);
      output.push(item);
      if (output.length >= maxElements) break;
      const isMenuTree = String(item.role || '').startsWith('AXMenu');
      if (current.depth + 1 < maxDepth && (includeMenus || !isMenuTree)) stack.push({ element: child, depth: current.depth + 1 });
    }
  }
  return { output, elements, truncated: stack.length > 0 || output.length >= maxElements };
}
function matches(item, selector) {
  for (const key of ['role','subrole','name','title','description','identifier']) {
    if (selector[key] !== undefined && String(item[key] || '').toLowerCase() !== String(selector[key]).toLowerCase()) return false;
  }
  return true;
}
function main() {
  const payload = readPayload();
  const se = Application('System Events');
  const process = se.applicationProcesses.byName(payload.application);
  if (!safe(() => process.exists(), false)) throw new Error('application process not found or Accessibility access denied');
  if (payload.operation === 'inspect') {
    const flattened = flatten(process, payload.maxDepth, payload.maxElements, payload.includeValues === true, payload.includeMenus === true);
    return { frontmost: safe(() => process.frontmost(), false), elements: flattened.output, truncated: flattened.truncated, menus_included: payload.includeMenus === true };
  }
  if (payload.action === 'activate') {
    process.frontmost = true;
    return { ok: true, matched: 1 };
  }
  const flattened = flatten(process, payload.maxDepth, payload.maxElements, true, payload.includeMenus === true);
  const matchesList = [];
  for (let i = 0; i < flattened.output.length; i++) if (matches(flattened.output[i], payload.selector)) matchesList.push(i);
  const chosen = payload.selector.index !== undefined ? matchesList[payload.selector.index] : matchesList[0];
  if (chosen === undefined || chosen < 0 || chosen >= flattened.elements.length) throw new Error('no UI element matched selector');
  const element = flattened.elements[chosen];
  if (payload.action === 'click' || payload.action === 'press') {
    const action = safe(() => element.actions.byName('AXPress'), null);
    if (action && safe(() => action.exists(), false)) action.perform();
    else element.click();
  } else if (payload.action === 'set_value') {
    if (payload.value === null) throw new Error('set_value requires value or value_resource');
    element.value = payload.value;
  } else if (payload.action === 'focus') {
    element.focused = true;
  } else if (payload.action === 'keystroke') {
    process.frontmost = true;
    element.focused = true;
    if (payload.value === null) throw new Error('keystroke requires value or value_resource');
    se.keystroke(payload.value);
  } else {
    throw new Error('unsupported action');
  }
  return { ok: true, matched: matchesList.length, selected_index: chosen, element: describe(element, chosen, false) };
}
(() => { try { return JSON.stringify(main()); } catch (error) { return JSON.stringify({ error: String(error.message || error) }); } })()
`;
