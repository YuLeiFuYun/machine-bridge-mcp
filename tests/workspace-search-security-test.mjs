import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { WorkspaceFileService } from "../src/local/workspace-file-service.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-workspace-search-security-"));
let workspace = join(root, "workspace");
const controlStateRoot = join(root, "state");
const serviceControlRoot = join(root, "machine-service-control");
try {
  await mkdir(join(workspace, "nested"), { recursive: true });
  await mkdir(join(workspace, "node_modules", "fixture"), { recursive: true });
  await mkdir(join(workspace, "dist"), { recursive: true });
  await mkdir(controlStateRoot, { recursive: true });
  await mkdir(serviceControlRoot, { recursive: true });
  workspace = await realpath(workspace);
  const protectedRoots = [await realpath(controlStateRoot), await realpath(serviceControlRoot)];
  await writeFile(join(controlStateRoot, "state.json"), "CONTROL_PLANE_MARKER state\n");
  await writeFile(join(serviceControlRoot, "service-operation.lock"), "CONTROL_PLANE_MARKER service\n");
  await writeFile(join(workspace, ".env"), "API_KEY=synthetic-search-secret\n");
  await writeFile(join(workspace, "nested", "server.key"), "synthetic-key-secret\n");
  await writeFile(join(workspace, ".netrc"), "login synthetic-netrc-login password synthetic-netrc-secret\n");
  await writeFile(join(workspace, "_netrc"), "login synthetic-windows-login password synthetic-windows-secret\n");
  await writeFile(join(workspace, ".curlrc"), "user = synthetic-curl-secret\n");
  await mkdir(join(workspace, "src", "worker"), { recursive: true });
  await mkdir(join(workspace, "tests"), { recursive: true });
  await writeFile(join(workspace, "src", "tokenizer.js"), "ordinary-code-marker tokenizer\n");
  await writeFile(join(workspace, "src", "worker", "oauth-tokens.ts"), "ordinary-code-marker oauth source\n");
  await writeFile(join(workspace, "tests", "private-key-test.mjs"), "ordinary-code-marker private-key test\n");
  await writeFile(join(workspace, "visible.txt"), "ordinary NEEDLE visible text\n");
  await writeFile(join(workspace, "node_modules", "fixture", "ignored.txt"), "IGNORED_MATCH from dependency tree\n");
  await writeFile(join(workspace, "dist", "ignored.txt"), "IGNORED_MATCH from build output\n");
  await writeFile(join(workspace, "context.txt"), "context before\nTargetNeedle in the middle\ncontext after\n");
  const service = new WorkspaceFileService({
    workspace,
    policy: {},
    policyGate: { assert() {} },
    resolveExistingPath: async (value) => realpath(resolve(workspace, String(value || "."))),
    resolveWritePath: async (value) => resolve(workspace, String(value || ".")),
    displayPath: (value) => relative(workspace, value) || ".",
    throwIfCancelled() {},
    withMutationPaths: async (_paths, run) => run(),
    isProtectedPath: (value) => protectedRoots.some((protectedRoot) => {
      const candidate = resolve(value);
      return candidate === protectedRoot || candidate.startsWith(`${protectedRoot}${sep}`);
    }),
  });
  const delegated = {
    origin: "relay",
    authority: {
      owner: false,
      principal: { kind: "account", role: "reviewer" },
      effectivePolicy: { unrestrictedPaths: false, allowExec: false },
    },
  };
  const delegatedSearch = await service.searchText({ path: ".", query: "synthetic-" , max_matches: 100 }, delegated);
  assert(!JSON.stringify(delegatedSearch.matches).includes("synthetic-search-secret")
    && !JSON.stringify(delegatedSearch.matches).includes("synthetic-key-secret")
    && !JSON.stringify(delegatedSearch.matches).includes("synthetic-netrc-secret")
    && !JSON.stringify(delegatedSearch.matches).includes("synthetic-windows-secret")
    && !JSON.stringify(delegatedSearch.matches).includes("synthetic-curl-secret"),
  "delegated recursive search exposed a sensitive file");
  assert(delegatedSearch.skipped_files >= 5 && delegatedSearch.truncated === true,
    "delegated recursive search did not report skipped sensitive files as incomplete");
  const ordinaryCodeSearch = await service.searchText({ path: ".", query: "ordinary-code-marker", max_matches: 100 }, delegated);
  assert(ordinaryCodeSearch.matches.length === 3
      && ordinaryCodeSearch.matches.some((match) => match.path === join("src", "tokenizer.js"))
      && ordinaryCodeSearch.matches.some((match) => match.path === join("src", "worker", "oauth-tokens.ts"))
      && ordinaryCodeSearch.matches.some((match) => match.path === join("tests", "private-key-test.mjs")),
    "delegated recursive search blocked ordinary source files with credential-related substrings in their names");

  const delegatedOwner = {
    origin: "relay",
    authority: {
      owner: true,
      principal: { kind: "account", role: "owner" },
      effectivePolicy: { unrestrictedPaths: true, allowExec: true },
    },
  };
  const protectedStateSearch = await service.searchText({ path: "..", query: "CONTROL_PLANE_MARKER", max_matches: 100 }, delegatedOwner);
  assert(protectedStateSearch.matches.length === 0 && protectedStateSearch.skipped_files >= 2 && protectedStateSearch.truncated === true,
    `recursive search exposed control-plane files when the requested root was their ancestor: ${JSON.stringify(protectedStateSearch)}`);
  const protectedStateListing = await service.listFiles("..", 1000, delegatedOwner);
  assert(!protectedStateListing.files.some((value) => value.startsWith(`..${sep}state${sep}`)
      || value.startsWith(`..${sep}machine-service-control${sep}`))
      && protectedStateListing.skipped_files >= 2 && protectedStateListing.truncated === true,
    "recursive file listing exposed protected control-plane paths or hid that its results were incomplete");

  const ownerSearch = await service.searchText({ path: ".", query: "API_KEY=synthetic-search-secret", max_matches: 100 }, { origin: "local" });
  assert(ownerSearch.matches.some((match) => match.path === ".env"),
    `sensitive-path filtering changed the trusted local-owner search behavior: ${JSON.stringify(ownerSearch)}`);

  const ignoredByDefault = await service.searchText({ path: ".", query: "IGNORED_MATCH", max_matches: 100 }, { origin: "local" });
  assert(ignoredByDefault.matches.length === 0, "search traversed generated/dependency directories by default");
  const includeIgnored = await service.searchText({ path: ".", query: "IGNORED_MATCH", max_matches: 100, include_ignored: true }, { origin: "local" });
  assert(includeIgnored.matches.length === 2, "include_ignored=true did not restore generated/dependency directory traversal");
  const globbed = await service.searchText({ path: ".", query: "synthetic-key-secret", glob: "nested/*.key" }, { origin: "local" });
  assert(globbed.matches.length === 1 && globbed.matches[0].path === join("nested", "server.key"),
    "search glob did not constrain candidate paths");
  const caseSensitive = await service.searchText({ path: "context.txt", query: "targetneedle" }, { origin: "local" });
  const caseInsensitive = await service.searchText({ path: "context.txt", query: "targetneedle", case_sensitive: false, context_lines: 1 }, { origin: "local" });
  assert(caseSensitive.matches.length === 0 && caseInsensitive.matches.length === 1
      && caseInsensitive.matches[0].before[0] === "context before"
      && caseInsensitive.matches[0].after[0] === "context after",
    "case-insensitive search or bounded context lines returned incorrect results");
  await assertReject(() => service.searchText({ path: ".", query: "needle", glob: "/etc/*" }, { origin: "local" }), "invalid_glob");
  await assertReject(() => service.searchText({ path: ".", query: "needle", glob: "../**/*" }, { origin: "local" }), "invalid_glob");
  await assertReject(() => service.searchText({ path: ".", query: "q".repeat(4097) }, { origin: "local" }), "query_too_long");

  const contextHeavyPath = join(workspace, "context-heavy.txt");
  const wideLine = "x".repeat(400) + "BUDGET_NEEDLE" + "y".repeat(400);
  await writeFile(contextHeavyPath, Array.from({ length: 1000 }, () => wideLine).join("\n"));
  const contextHeavy = await service.searchText({ path: "context-heavy.txt", query: "BUDGET_NEEDLE", context_lines: 5, max_matches: 1000 }, { origin: "local" });
  assert(contextHeavy.truncated === true && contextHeavy.matches.length < 1000
      && Buffer.byteLength(JSON.stringify(contextHeavy)) <= 1024 * 1024,
    "search context output exceeded its bounded serialized-result budget");
  const listedDefault = await service.listFiles(".", 1000, { origin: "local" });
  const listedAll = await service.listFiles(".", 1000, { origin: "local" }, { includeIgnored: true });
  assert(!listedDefault.files.some((value) => value.includes("node_modules") || value.startsWith(`dist${sep}`))
      && listedAll.files.some((value) => value === join("node_modules", "fixture", "ignored.txt")),
    "list_files did not apply or override the default ignored-directory policy");

  const largePath = join(workspace, "large.txt");
  await writeFile(largePath, "x".repeat(1024 * 1024 + 128) + "LATE_NEEDLE");
  const largeSearch = await service.searchText({ path: "large.txt", query: "LATE_NEEDLE" }, delegated);
  assert(largeSearch.matches.length === 0 && largeSearch.skipped_files === 1 && largeSearch.truncated === true,
    "search skipped an oversized file without exposing that the result is incomplete");

  const longLinePath = join(workspace, "long-line.txt");
  await writeFile(longLinePath, "x".repeat(700) + "LATE_LINE_NEEDLE" + "y".repeat(700) + "\n");
  const longLineSearch = await service.searchText({ path: "long-line.txt", query: "LATE_LINE_NEEDLE" }, delegated);
  const match = longLineSearch.matches[0];
  assert(match?.text.includes("LATE_LINE_NEEDLE") && match.match_offset === 242
      && match.line_offset === 458 && match.column === 700 && match.text.length === 500,
    "search result snippet omitted the matched text from a long line");

  const outside = join(root, "outside.txt");
  await writeFile(outside, "HARDLINK_SECRET=synthetic-hardlink-secret\n");
  await link(outside, join(workspace, "ordinary-hardlink.txt"));
  const hardlinkSearch = await service.searchText({ path: ".", query: "HARDLINK_SECRET", max_matches: 100 }, delegated);
  assert(!JSON.stringify(hardlinkSearch.matches).includes("synthetic-hardlink-secret")
    && hardlinkSearch.skipped_files >= 1 && hardlinkSearch.truncated === true,
  "recursive search exposed a hard-linked file or reported a complete result");
  console.log("workspace search security test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertReject(callback, reason) {
  try { await callback(); } catch (error) {
    assert(error?.details?.reason === reason, `expected rejection reason ${reason}, received ${error?.details?.reason}`);
    return;
  }
  throw new Error(`expected rejection: ${reason}`);
}
