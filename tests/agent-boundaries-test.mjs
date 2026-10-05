import { renameSync, symlinkSync } from "node:fs";
import fs, { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { publicSkillWarnings } from "../src/local/agent-context-projection.mjs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  discoverLocalSkills, listSkillFiles, parseSkillMetadata,
} from "../src/local/agent-skill-discovery.mjs";
import { readOptionalRegularUtf8, readRegularUtf8 } from "../src/local/agent-text-file.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-agent-boundaries-"));
const workspace = join(root, "workspace");
const skillRoot = join(workspace, "skills");
const outside = join(root, "outside");
let canonicalWorkspace = workspace;
try {
  await mkdir(skillRoot, { recursive: true });
  canonicalWorkspace = await realpath(workspace);
  await mkdir(outside, { recursive: true });

  assert(await readOptionalRegularUtf8(join(root, "missing.txt"), 16, "optional text") === null, "missing optional text did not return null");
  const validText = join(root, "valid.txt");
  await writeFile(validText, "hello", "utf8");
  const valid = await readRegularUtf8(validText, 5, "valid text");
  assert(valid.text === "hello" && valid.bytes === 5, "bounded UTF-8 reader lost text or byte count");
  assert((await readOptionalRegularUtf8(validText, 5, "optional text")).text === "hello", "optional text reader lost stable path-alias support");
  await expectReject(() => readRegularUtf8(validText, 4, "valid text"), "exceeds maximum size");
  await expectReject(() => readRegularUtf8(root, 1024, "directory text"), "not a regular file");
  await expectReject(() => readOptionalRegularUtf8(root, 1024, "optional directory"), "not a regular file");
  const invalidUtf8 = join(root, "invalid-utf8.txt");
  await writeFile(invalidUtf8, Buffer.from([0xff]));
  await expectReject(() => readRegularUtf8(invalidUtf8, 8, "invalid text"), "not valid UTF-8");
  const textLink = join(root, "text-link.txt");
  if (await createSymlink(validText, textLink, "file")) {
    await expectReject(() => readOptionalRegularUtf8(textLink, 16, "linked text"), "must not be a symbolic link");
  }

  await createSkill(join(skillRoot, "alpha"), "skill.md", "alpha-skill", "Alpha workflow.");
  await createSkill(join(skillRoot, "beta"), "SKILL.md", "beta-skill", "Beta workflow.");
  await mkdir(join(skillRoot, "invalid"), { recursive: true });
  await writeFile(join(skillRoot, "invalid", "SKILL.md"), "---\nname: invalid\n---\n", "utf8");

  const discovered = await discoverLocalSkills(discoveryOptions({ skillRoots: [join(root, "missing-skills"), skillRoot] }));
  assert(discovered.skills.map((skill) => skill.name).join(",") === "alpha-skill,beta-skill", "skill discovery lost deterministic ordering or lowercase entrypoint support");
  assert(discovered.warnings.length === 1 && discovered.warnings[0].message.includes("requires non-empty name and description"), "invalid skill metadata was not bounded into a warning");

  const brokenLink = join(skillRoot, "broken-skill-link");
  if (await createSymlink(join(skillRoot, "missing-target"), brokenLink, "dir")) {
    const withBrokenLink = await discoverLocalSkills(discoveryOptions({ skillRoots: [skillRoot] }));
    const brokenWarning = withBrokenLink.warnings.find((warning) => warning.entrypoint.endsWith("broken-skill-link"));
    assert(brokenWarning, "broken skill symlink was silently omitted without a bounded warning");
    assert(!brokenWarning.message.includes(root) && brokenWarning.message.includes("not_found"),
      "skill warning leaked an absolute path instead of a coarse error class");
    await rm(brokenLink, { force: true });
  }

  const filtered = await discoverLocalSkills(discoveryOptions({ skillRoots: [skillRoot], query: "beta" }));
  assert(filtered.skills.length === 1 && filtered.skills[0].name === "beta-skill", "skill query did not filter metadata");
  const limited = await discoverLocalSkills(discoveryOptions({ skillRoots: [skillRoot], maxResults: 1 }));
  assert(limited.skills.length === 1 && limited.truncated, "skill result ceiling did not report truncation");

  const nonDirectoryRoot = join(workspace, "not-a-directory");
  await writeFile(nonDirectoryRoot, "file", "utf8");
  await expectReject(() => discoverLocalSkills(discoveryOptions({ skillRoots: [nonDirectoryRoot] })), "skill root is not a directory");

  const inventoryRoot = join(skillRoot, "inventory");
  await mkdir(join(inventoryRoot, "nested"), { recursive: true });
  await writeFile(join(inventoryRoot, "nested", "file.txt"), "x", "utf8");
  if (await createSymlink(validText, join(inventoryRoot, "linked.txt"), "file")) {
    const inventory = await listSkillFiles(inventoryRoot, 10, {}, () => {});
    assert(inventory.files.some((item) => item.path === "linked.txt" && item.type === "symlink"), "skill inventory did not preserve symbolic-link metadata");
  }
  const limitedInventory = await listSkillFiles(inventoryRoot, 1, {}, () => {});
  assert(limitedInventory.files.length === 1 && limitedInventory.truncated, "skill inventory ceiling did not report truncation");

  const outsideSkill = join(outside, "outside-skill");
  await createSkill(outsideSkill, "SKILL.md", "outside-skill", "Outside workflow.");
  const outsideLink = join(skillRoot, "outside-link");
  if (await createSymlink(outsideSkill, outsideLink, "dir")) {
    await expectReject(() => discoverLocalSkills(discoveryOptions({ skillRoots: [skillRoot] })), "outside the configured workspace");
  }

  assert(Object.keys(parseSkillMetadata("plain text")).length === 0, "plain skill text produced metadata");
  assert(Object.keys(parseSkillMetadata("---\nname: incomplete\n")).length === 0, "unterminated front matter produced metadata");
  const crlf = parseSkillMetadata("---\r\nname: \"quoted\"\r\ndescription: 'description'\r\n---\r\n");
  assert(crlf.name === "quoted" && crlf.description === "description", "CRLF or quoted skill metadata parsing failed");

  let cancellationChecks = 0;
  await discoverLocalSkills(discoveryOptions({
    skillRoots: [skillRoot],
    throwIfCancelled() {
      cancellationChecks += 1;
      if (cancellationChecks > 1) throw new Error("cancelled scan");
    },
  })).then(() => { throw new Error("cancelled skill scan unexpectedly completed"); }, (error) => {
    assert(String(error.message).includes("cancelled scan"), "skill scan lost cancellation error");
  });

  await testPrivateSkillWarning();
  await testDirectoryReplacementBoundary("discover");
  await testDirectoryReplacementBoundary("inventory");
  await testSkillFilesystemBoundaries(await realpath(root));
  console.log("agent boundary test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function discoveryOptions(overrides = {}) {
  return {
    skillRoots: [],
    query: "",
    maxResults: 100,
    workspace: canonicalWorkspace,
    unrestricted: false,
    displayPath: (value) => value,
    context: {},
    throwIfCancelled: () => {},
    ...overrides,
  };
}

async function createSkill(directory, filename, name, description) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

async function createSymlink(target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return false;
    throw error;
  }
}

async function expectReject(operation, expected) {
  try {
    await operation();
  } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected '${expected}', got '${error?.message || error}'`);
    return;
  }
  throw new Error(`expected rejection containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function testPrivateSkillWarning() {
  const directory = join(workspace, "warning-skill");
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), Buffer.from([0xff]));
  const discovered = await discoverLocalSkills(discoveryOptions({ skillRoots: [directory] }));
  const warnings = publicSkillWarnings(discovered.warnings, (path) => relative(canonicalWorkspace, path));
  assert(warnings.length === 1 && warnings[0].message.includes("not valid UTF-8"),
    "malformed skill did not retain a useful warning");
  assert(warnings[0].entrypoint === warnings[0].message.split(": ").at(-1),
    "skill warning message and entrypoint did not use the same path projection");
  assert(!JSON.stringify(warnings).includes(canonicalWorkspace),
    "malformed skill warning disclosed the restricted workspace's absolute path");
}

async function testDirectoryReplacementBoundary(mode) {
  const directory = join(workspace, "race-" + mode);
  const child = join(directory, "child");
  await mkdir(child, { recursive: true });
  const canonicalChild = await realpath(child);
  let replaced = false;
  await withFilesystemHook("realpath", (original) => async (...args) => {
    if (args[0] === canonicalChild && !replaced) {
      renameSync(child, child + "-original");
      symlinkSync(outside, child, process.platform === "win32" ? "junction" : "dir");
      replaced = true;
    }
    return original(...args);
  }, () => expectReject(() => mode === "discover"
    ? discoverLocalSkills(discoveryOptions({ skillRoots: [directory] }))
    : listSkillFiles(directory, 10, {}, () => {}), "outside the configured workspace"));
  assert(replaced, "directory replacement fixture did not reach the queued scan boundary");
}

async function testSkillFilesystemBoundaries(testRoot) {
  const fixture = async (name) => {
    const workspace = join(testRoot, "boundaries", name, "workspace");
    const directory = join(workspace, "skills"), outside = join(testRoot, "boundaries", name, "outside");
    await mkdir(directory, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: owned-inside\ndescription: Ordinary fixture.\n---\n");
    await writeFile(join(outside, "SKILL.md"), "---\nname: owned-outside\ndescription: External fixture.\n---\n");
    await writeFile(join(outside, "outside.txt"), "Synthetic metadata.");
    return { workspace, directory, outside };
  };
  const discover = (value) => discoverLocalSkills({
    skillRoots: [value.directory], query: "", maxResults: 10, workspace: value.workspace,
    unrestricted: false, displayPath: () => "<fixture>", context: {}, throwIfCancelled() {},
  });
  const stable = await fixture("stable");
  assert((await discover(stable)).skills[0]?.name === "owned-inside", "ordinary skill discovery failed");
  assert((await listSkillFiles(stable.directory, 10, {}, () => {})).files.length === 1, "ordinary skill inventory failed");

  const inventory = await fixture("directory-open");
  let opened = false, closed = false;
  await withFilesystemHook("opendir", (original) => async (...args) => {
    if (args[0] !== inventory.directory) return original(...args);
    opened = true;
    await fs.rename(inventory.directory, inventory.directory + "-held");
    await symlink(inventory.outside, inventory.directory, process.platform === "win32" ? "junction" : "dir");
    const handle = await original(...args), close = handle.close.bind(handle);
    handle.close = async (...closeArgs) => { closed = true; return close(...closeArgs); };
    return handle;
  }, async () => {
    await expectReject(() => listSkillFiles(inventory.directory, 10, {}, () => {}), "changed during traversal");
  });
  assert(opened && closed, "changed-directory rejection leaked its opened directory handle");

  const summary = await fixture("skill-file-open");
  let intercepted = false, fileClosed = false;
  await withFilesystemHook("open", (original) => async (...args) => {
    if (args[0] !== join(summary.directory, "SKILL.md")) return original(...args);
    intercepted = true;
    await fs.rename(summary.directory, summary.directory + "-held");
    await symlink(summary.outside, summary.directory, process.platform === "win32" ? "junction" : "dir");
    const handle = await original(...args), close = handle.close.bind(handle);
    handle.close = async (...closeArgs) => { fileClosed = true; return close(...closeArgs); };
    return handle;
  }, async () => {
    const result = await discover(summary);
    assert(result.skills.length === 0 && result.warnings.length === 1
      && result.warnings[0].message.includes("changed during read"),
    "replaced skill parent exposed outside metadata or lost its bounded warning");
  });
  assert(intercepted && fileClosed, "changed-file rejection leaked its opened file handle");

  const preselected = await fixture("canonical-path-replacement");
  const selectedEntrypoint = join(preselected.directory, "SKILL.md");
  await fs.rename(preselected.directory, preselected.directory + "-held");
  await symlink(preselected.outside, preselected.directory, process.platform === "win32" ? "junction" : "dir");
  await expectReject(() => readRegularUtf8(selectedEntrypoint, 1024, "selected skill", { canonicalPath: selectedEntrypoint }), "changed during read");
  await expectReject(() => listSkillFiles(preselected.directory, 10, {}, () => {}, preselected.directory), "changed during traversal");

  const changedKind = await fixture("entry-kind-replacement");
  const changedKindPath = join(changedKind.directory, "SKILL.md");
  let kindChanged = false;
  await withFilesystemHook("lstat", (original) => async (...args) => {
    if (args[0] === changedKindPath && !kindChanged) {
      kindChanged = true;
      await fs.rename(changedKindPath, changedKindPath + "-held");
      await mkdir(changedKindPath);
    }
    return original(...args);
  }, () => expectReject(() => listSkillFiles(changedKind.directory, 10, {}, () => {}), "skill file changed during traversal"));
  assert(kindChanged, "file-kind replacement fixture did not reach the native stat boundary");

  const replaced = await fixture("same-path-replacement");
  const replacementPath = join(replaced.directory, "SKILL.md");
  await withFilesystemHook("open", (original) => async (...args) => {
    if (args[0] === replacementPath) {
      await fs.rename(replacementPath, replacementPath + "-held");
      await writeFile(replacementPath, "---\nname: replacement\ndescription: Replacement fixture.\n---\n");
    }
    return original(...args);
  }, () => expectReject(() => readRegularUtf8(replacementPath, 1024, "owned file"), "changed during read"));

  const modified = await fixture("during-read");
  const modifiedPath = join(modified.directory, "SKILL.md");
  await withFilesystemHook("open", (original) => async (...args) => {
    const handle = await original(...args);
    if (args[0] === modifiedPath) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        await writeFile(modifiedPath, "changed after read");
        return result;
      };
    }
    return handle;
  }, () => expectReject(() => readRegularUtf8(modifiedPath, 1024, "owned file"), "changed during read"));

  let optionalOpened = false;
  await withFilesystemHook("open", (original) => async (...args) => {
    if (args[0] === join(stable.directory, "SKILL.md")) optionalOpened = true;
    return original(...args);
  }, () => expectReject(() => readOptionalRegularUtf8(join(stable.directory, "SKILL.md"), 1024, "optional file", () => {
    throw new Error("fixture path rejected");
  }), "fixture path rejected"));
  assert(!optionalOpened, "optional-file boundary validation ran after opening the file");
  assert(await readOptionalRegularUtf8(join(stable.directory, "missing.md"), 1024, "missing file", () => {
    throw new Error("missing files must not invoke canonical validation");
  }) === null, "absent optional file lost its null result");
}

async function withFilesystemHook(name, createHook, callback) {
  const original = fs[name];
  fs[name] = createHook(original);
  syncBuiltinESMExports();
  try { return await callback(); }
  finally { fs[name] = original; syncBuiltinESMExports(); }
}
