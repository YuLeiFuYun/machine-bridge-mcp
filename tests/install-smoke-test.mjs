import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("install smoke test must run through an npm lifecycle so npm_execpath is available");

const temp = mkdtempSync(join(tmpdir(), "mbm-install-smoke-"));
const prefix = join(temp, "prefix");
const installCwd = join(temp, "package-free-cwd");
mkdirSync(installCwd);
try {
  const packed = runNpm(["pack", "--silent", "--json", "--pack-destination", temp], root);
  let metadata;
  try { metadata = JSON.parse(packed.stdout); } catch {
    throw new Error(`npm pack did not return clean JSON: ${packed.stdout.slice(0, 500)}`);
  }
  const record = normalizePackRecord(metadata);
  if (!record?.filename) throw new Error("npm pack did not report the tarball filename");
  const tarball = join(temp, record.filename);

  const installArgs = [
    "install",
    "--global",
    "--prefix", prefix,
    "--omit=optional",
    "--allow-scripts=esbuild,workerd,sharp,fsevents",
    tarball,
  ];
  const npmVersion = runNpm(["--version"], installCwd).stdout.trim();
  if (Number(npmVersion.split(".")[0]) < 12) throw new Error(`install smoke test requires npm 12 or newer; current ${npmVersion}`);

  const installed = runNpm(installArgs, installCwd);
  const installOutput = `${installed.stdout}\n${installed.stderr}`;
  if (/install scripts? blocked|not covered by allowScripts|fsevents@2\.3\.3/i.test(installOutput)) {
    throw new Error(`documented global install emitted an optional/native-script warning: ${installOutput.slice(0, 1000)}`);
  }

  const globalRoot = runNpm(["root", "--global", "--prefix", prefix], root).stdout.trim();
  const installedPackage = join(globalRoot, "machine-bridge-mcp");
  const pkg = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
  if (pkg.version !== record.version) throw new Error(`installed version ${pkg.version} did not match packed version ${record.version}`);
  if (pkg.engines?.npm !== ">=12.0.0") throw new Error("installed package omitted the npm 12 runtime requirement");
  if (containsNamedEntry(installedPackage, "fsevents")) throw new Error("optional fsevents package remained in the documented runtime installation");

  const cli = spawnSync(process.execPath, [join(installedPackage, "bin", "machine-mcp.mjs"), "--version"], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
  });
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cli.stdout.includes(`machine-bridge-mcp ${pkg.version}`)) {
    throw new Error(`installed CLI failed: ${cli.stderr || cli.stdout}`);
  }

  assertInstalledDefaultStartup(installedPackage, temp);

  console.log(`global install smoke test ok (${pkg.version}; default startup reached controlled external boundary; optional fsevents omitted)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function assertInstalledDefaultStartup(installedPackage, temp) {
  const wranglerEntrypoint = join(installedPackage, "node_modules", "wrangler", "bin", "wrangler.js");
  writeFileSync(
    wranglerEntrypoint,
    'process.stderr.write("startup-probe-wrangler\\n");\nprocess.exit(73);\n',
    "utf8",
  );

  const workspace = join(temp, "startup-workspace");
  const home = join(temp, "startup-home");
  const stateHome = join(temp, "startup-state");
  const appData = join(temp, "startup-appdata");
  for (const directory of [workspace, home, stateHome, appData]) mkdirSync(directory, { recursive: true });

  const result = spawnSync(process.execPath, [join(installedPackage, "bin", "machine-mcp.mjs")], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_STATE_HOME: stateHome,
      APPDATA: appData,
      MBM_DEBUG: "1",
      CI: "1",
    },
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 1 || !output.includes("startup-probe-wrangler")) {
    throw new Error(`installed zero-argument startup did not reach the controlled Wrangler boundary: ${output.slice(0, 2000)}`);
  }
  if (/ReferenceError|\bis not defined\b/.test(output)) {
    throw new Error(`installed zero-argument startup crashed on an undefined identifier: ${output.slice(0, 2000)}`);
  }
  const stateRoot = process.platform === "win32"
    ? join(appData, "machine-bridge-mcp")
    : join(stateHome, "machine-bridge-mcp");
  if (!readFileSync(join(stateRoot, ".machine-bridge-mcp-state"), "utf8").includes("machine-bridge-mcp")) {
    throw new Error("installed zero-argument startup did not initialize isolated state before the external boundary");
  }
}

function spawnNpm(args, cwd) {
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 300_000,
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
