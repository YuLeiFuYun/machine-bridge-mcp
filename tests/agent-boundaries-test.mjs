import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
