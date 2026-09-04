import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let npmCli;
const temp = mkdtempSync(join(tmpdir(), "mbm-install-smoke-"));
const prefix = join(temp, "prefix");
const installCwd = join(temp, "package-free-cwd");
mkdirSync(installCwd);
try {
  npmCli = String(process.env.npm_execpath || "").trim();
  if (!npmCli) throw new Error("install smoke test must run through an npm lifecycle so npm_execpath is available");
  npmCli = realpathSync(npmCli);
  const packed = runNpm(["pack", "--dry-run=false", "--workspaces=false", "--global=false", "--prefix", root, "--silent", "--json", "--pack-destination", temp], root);
  let metadata;
  try { metadata = JSON.parse(packed.stdout); } catch {
    throw new Error(`npm pack did not return clean JSON: ${packed.stdout.slice(0, 500)}`);
  }
  const record = normalizePackRecord(metadata);
  if (!record?.filename) throw new Error("npm pack did not report the tarball filename");
  const tarball = join(temp, record.filename);
  const productionClosure = packOfflineProductionClosure(join(temp, "production-closure"));

  const installArgs = [
    "install",
    "--dry-run=false",
    "--workspaces=false",
    "--ignore-scripts=false",
    "--global",
    "--prefix", prefix,
    "--omit=optional",
    "--include=prod",
    "--package-lock-only=false",
    "--allow-scripts=esbuild,workerd,sharp,fsevents",
    "--offline",
    "--no-audit",
    "--no-fund",
    tarball,
    ...productionClosure,
  ];
  const npmVersion = runNpm(["--version"], installCwd).stdout.trim();
  if (Number(npmVersion.split(".")[0]) < 12) throw new Error(`install smoke test requires npm 12 or newer; current ${npmVersion}`);

  const installed = runNpm(installArgs, installCwd);
  const installOutput = `${installed.stdout}\n${installed.stderr}`;
  if (/install scripts? blocked|not covered by allowScripts|fsevents@2\.3\.3/i.test(installOutput)) {
    throw new Error(`documented global install emitted an optional/native-script warning: ${installOutput.slice(0, 1000)}`);
  }

  const globalRoot = runNpm(["root", "--json=false", "--parseable=false", "--workspaces=false", "--global", "--prefix", prefix], root).stdout.trim();
  const installedPackage = join(globalRoot, "machine-bridge-mcp");
  const pkg = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
  if (pkg.version !== record.version) throw new Error(`installed version ${pkg.version} did not match packed version ${record.version}`);
  if (pkg.engines?.npm !== ">=12.0.0") throw new Error("installed package omitted the npm 12 runtime requirement");
  if (containsNamedEntry(installedPackage, "fsevents")) throw new Error("optional fsevents package remained in the documented runtime installation");
  for (const name of ["wrangler", "miniflare"]) {
    if (containsNamedEntry(installedPackage, name)) throw new Error(`published runtime package retained private control-plane dependency ${name}`);
  }

  const cli = spawnSync(process.execPath, [join(installedPackage, "bin", "machine-mcp.mjs"), "--version"], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cli.stdout.includes(`machine-bridge-mcp ${pkg.version}`)) {
    throw new Error(`installed CLI failed: ${cli.stderr || cli.stdout}`);
  }

  await assertInstalledDefaultStartup(installedPackage, temp);

  console.log(`global install smoke test ok (${pkg.version}; offline production closure installed; default startup reached controlled external boundary; optional fsevents omitted)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function assertInstalledDefaultStartup(installedPackage, temp) {
  const workspace = join(temp, "startup-workspace");
  const serviceTrap = createServiceManagerTrap(temp);
  const home = join(temp, "startup-home");
  const stateHome = join(temp, "startup-state");
  const appData = join(temp, "startup-appdata");
  for (const directory of [workspace, home, stateHome, appData]) mkdirSync(directory, { recursive: true });
  const stateRoot = process.platform === "win32"
    ? join(appData, "machine-bridge-mcp")
    : join(stateHome, "machine-bridge-mcp");

  const { setSelectedWorkspace } = await import(pathToFileURL(join(installedPackage, "src", "local", "state.mjs")).href);
  const selectedWorkspace = process.platform === "win32" ? join(home, "MachineBridge") : workspace;
  mkdirSync(selectedWorkspace, { recursive: true });
  setSelectedWorkspace(selectedWorkspace, stateRoot);
  const startupHarness = join(temp, "startup-probe.mjs");
  const cliModuleUrl = pathToFileURL(join(installedPackage, "src", "local", "cli.mjs")).href;
  writeFileSync(startupHarness, `import { main } from ${JSON.stringify(cliModuleUrl)};
try {
  await main([], {
    ensureWorkerDeployment: async () => { throw new Error("startup-probe-worker-deployment"); },
  });
  process.stderr.write("startup probe unexpectedly completed\\n");
  process.exit(74);
} catch (error) {
  process.stderr.write(String(error?.message || error) + "\\n");
  process.exit(1);
}
`, "utf8");

  const result = spawnSync(process.execPath, [startupHarness], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_STATE_HOME: stateHome,
      APPDATA: appData,
      PATH: [serviceTrap.bin, dirname(process.execPath)].join(delimiter),
      MBM_SERVICE_MANAGER_TRAP: serviceTrap.marker,
      MBM_DEBUG: "1",
      CI: "1",
    },
    timeout: 30_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 1 || !output.includes("startup-probe-worker-deployment")) {
    throw new Error(`installed zero-argument startup did not reach the controlled worker-deployment boundary: ${output.slice(0, 2000)}`);
  }
  if (/ReferenceError|\bis not defined\b/.test(output)) {
    throw new Error(`installed zero-argument startup crashed on an undefined identifier: ${output.slice(0, 2000)}`);
  }
  if (existsSync(serviceTrap.marker) || output.includes("Autostart stop command was unavailable")) {
    throw new Error(`isolated zero-argument startup attempted to control the machine-level service: ${output.slice(0, 2000)}`);
  }
  if (!readFileSync(join(stateRoot, ".machine-bridge-mcp-state"), "utf8").includes("machine-bridge-mcp")) {
    throw new Error("installed zero-argument startup did not initialize isolated state before the external boundary");
  }
  const config = JSON.parse(readFileSync(join(stateRoot, "config.json"), "utf8"));
  const canonicalRealpath = realpathSync.native || realpathSync;
  const expectedWorkspace = canonicalRealpath(selectedWorkspace);
  if (config.selectedWorkspace !== expectedWorkspace) {
    throw new Error(`installed zero-argument startup selected ${config.selectedWorkspace} instead of ${expectedWorkspace}`);
  }
}

function packOfflineProductionClosure(destination) {
  mkdirSync(destination, { recursive: true });
  const projectRoot = realpathSync(root);
  const listing = runNpm([
    "ls", "--omit=dev", "--omit=optional", "--all", "--parseable", "--workspaces=false",
  ], root);
  const packagePaths = [...new Set(String(listing.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    .map((value) => realpathSync(value))
    .filter((value) => value !== projectRoot);
  if (!packagePaths.length) throw new Error("offline install smoke found no production dependency closure");
  const identities = new Map();
  const specs = [];
  for (const packagePath of packagePaths) {
    const rel = relative(projectRoot, packagePath);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("offline install smoke dependency escaped the project dependency tree");
    }
    const manifest = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
    const name = String(manifest.name || "");
    const version = String(manifest.version || "");
    if (!name || !version || name === "machine-bridge-mcp" || name === "wrangler" || name === "miniflare") {
      throw new Error(`offline install smoke found an invalid production dependency: ${name || "unnamed"}@${version || "unknown"}`);
    }
    const prior = identities.get(name);
    if (prior && prior !== version) throw new Error(`offline install smoke requires multiple ${name} versions (${prior}, ${version})`);
    if (prior) continue;
    identities.set(name, version);
    const packed = runNpm([
      "pack", packagePath,
      "--dry-run=false", "--workspaces=false", "--global=false", "--ignore-scripts",
      "--silent", "--json", "--pack-destination", destination,
    ], root);
    const record = normalizePackRecord(JSON.parse(packed.stdout));
    if (!record?.filename || String(record.name || "") !== name || String(record.version || "") !== version) {
      throw new Error(`offline install smoke could not pack ${name}@${version}`);
    }
    specs.push(join(destination, record.filename));
  }
  return specs;
}

function createServiceManagerTrap(temp) {
  const bin = join(temp, "service-manager-trap-bin");
  const marker = join(temp, "service-manager-called.log");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    for (const name of ["schtasks.cmd", "powershell.cmd"]) {
      writeFileSync(join(bin, name), `@echo ${name} %*>>"%MBM_SERVICE_MANAGER_TRAP%"\r\n@exit /b 97\r\n`, "utf8");
    }
  } else {
    const name = process.platform === "darwin" ? "launchctl" : "systemctl";
    const script = `#!/bin/sh
printf '%s\n' "${name} $*" >> "$MBM_SERVICE_MANAGER_TRAP"
exit 97
`;
    const target = join(bin, name);
    writeFileSync(target, script, "utf8");
    chmodSync(target, 0o755);
  }
  return { bin, marker };
}

function spawnNpm(args, cwd) {
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: nestedNpmEnvironment(process.env),
    timeout: 300_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
}

function runNpm(args, cwd) {
  const result = spawnNpm(args, cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result;
}

function normalizePackRecord(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (!value || typeof value !== "object") return null;
  const preferred = value["machine-bridge-mcp"];
  if (preferred && typeof preferred === "object") return preferred;
  return Object.values(value).find((item) => item && typeof item === "object") || null;
}

function containsNamedEntry(start, name) {
  const queue = [start];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    if (++visited > 10_000) throw new Error("installed package traversal exceeded the safety limit");
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === name) return true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      queue.push(join(current, entry.name));
    }
  }
  return false;
}
