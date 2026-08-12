import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWranglerTypes } from "../scripts/generate-worker-types.mjs";
import { runWorkerDryRun, WRANGLER_DRY_RUN_COMPLETION_MARKER } from "../scripts/run-worker-dry-run.mjs";

const root = await mkdtemp(join(tmpdir(), "machine-bridge-wrangler-lifecycle-"));
const fixture = join(root, "wrangler-fixture.mjs");
const target = join(root, "worker-configuration.d.ts");
const typesCompletionMarker = "Remember to rerun 'wrangler types' after you change your wrangler.jsonc file.";

try {
  await writeFile(fixture, `
import { writeFileSync } from "node:fs";
const mode = process.env.MBM_WRANGLER_FIXTURE_MODE;
const command = process.argv[2];
let marker = "";
if (command === "types" && process.argv[3]) marker = ${JSON.stringify(`${typesCompletionMarker}\n`)};
else if (command === "deploy" && process.argv[3] === "--dry-run") marker = ${JSON.stringify(`${WRANGLER_DRY_RUN_COMPLETION_MARKER}\n`)};
else process.exit(9);
if (mode === "fail") process.exit(7);
if (mode === "hang-before") setInterval(() => {}, 1000);
else {
  if (command === "types") writeFileSync(process.argv[3], "interface Env {}\\n");
  if (mode === "normal-cleanup-race") process.on("SIGTERM", () => {
    process.stderr.write("fixture observed cleanup SIGTERM\\n");
  });
  process.stdout.write(marker);
  if (mode === "hang-after") setInterval(() => {}, 1000);
  else if (mode === "normal-cleanup-race") setTimeout(() => process.exit(0), 250);
}
`, "utf8");

  const normalTypes = capture();
  await runWranglerTypes(typesOptions("normal", normalTypes));
  assert.equal(await readFile(target, "utf8"), "interface Env {}\n", "normal Wrangler completion did not publish generated types");
  assert(normalTypes.stdout.includes(typesCompletionMarker), "normal Wrangler types output was not forwarded");
  assert(!normalTypes.stderr.includes("did not exit"), "normal Wrangler types exit was misclassified as a cleanup hang");

  const hangingTypes = capture();
  await runWranglerTypes(typesOptions("hang-after", hangingTypes));
  assert.equal(await readFile(target, "utf8"), "interface Env {}\n", "completed-but-hanging Wrangler lost generated types");
  assert(hangingTypes.stderr.includes("wrangler types completed but did not exit"), "completed Wrangler types hang was not diagnosed or bounded");

  const failedTypes = capture();
  await assert.rejects(runWranglerTypes(typesOptions("fail", failedTypes)), /exit code 7/);
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });

  const stalledTypes = capture();
  await assert.rejects(
    runWranglerTypes(typesOptions("hang-before", stalledTypes, { timeoutMs: 80 })),
    /wrangler types timed out after 80ms/,
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });

  const normalDryRun = capture();
  await runWorkerDryRun(commandOptions("normal", normalDryRun));
  assert(normalDryRun.stdout.includes(WRANGLER_DRY_RUN_COMPLETION_MARKER), "normal Wrangler dry-run output was not forwarded");
  assert(!normalDryRun.stderr.includes("did not exit"), "normal Wrangler dry-run exit was misclassified as a cleanup hang");

  const racedNormalDryRun = capture();
  await runWorkerDryRun(commandOptions("normal-cleanup-race", racedNormalDryRun, {
    completionExitGraceMs: 20,
    terminationGraceMs: 500,
  }));
  assert(racedNormalDryRun.stderr.includes("fixture observed cleanup SIGTERM"),
    "Wrangler cleanup-race fixture did not cross the completion grace");
  assert(!racedNormalDryRun.stderr.includes("did not exit"),
    "successful Wrangler dry-run exit lost to a raced cleanup request");

  const hangingDryRun = capture();
  await runWorkerDryRun(commandOptions("hang-after", hangingDryRun));
  assert(hangingDryRun.stderr.includes("wrangler deploy --dry-run completed but did not exit"),
    "completed Wrangler dry-run hang was not diagnosed or bounded");

  await assert.rejects(runWorkerDryRun(commandOptions("fail", capture())), /exit code 7/);
  await assert.rejects(
    runWorkerDryRun(commandOptions("hang-before", capture(), { timeoutMs: 80 })),
    /wrangler deploy --dry-run timed out after 80ms/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Wrangler command lifecycle test ok");

function typesOptions(mode, output, overrides = {}) {
  return { ...commandOptions(mode, output, overrides), targetPath: target };
}

function commandOptions(mode, output, overrides = {}) {
  return {
    cwd: root,
    wranglerPath: fixture,
    env: { ...process.env, MBM_WRANGLER_FIXTURE_MODE: mode },
    stdout: { write: (value) => { output.stdout += String(value); } },
    stderr: { write: (value) => { output.stderr += String(value); } },
    timeoutMs: 2_000,
    completionExitGraceMs: 500,
    terminationGraceMs: 200,
    ...overrides,
  };
}

function capture() {
  return { stdout: "", stderr: "" };
}
