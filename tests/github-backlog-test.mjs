import assert from "node:assert/strict";
import { assertGitHubBacklogReady, backlogBlockers, closingIssueNumbers, githubBacklogCommandTimeoutMs } from "../scripts/github-backlog.mjs";

assert.equal(githubBacklogCommandTimeoutMs, 120_000, "standalone GitHub backlog probes lost their bounded network-command deadline");

assert.deepEqual([...closingIssueNumbers("fix output\n\nCloses #47\nResolves: #51\nfixed #52")], [47, 51, 52], "closing keyword parser missed supported forms");
assert.deepEqual([...closingIssueNumbers("mentions #47 but does not close it")], [], "plain issue references incorrectly satisfied the backlog gate");

const ready = backlogBlockers({
  branch: "fix/current",
  commitMessages: "fix: current work\n\nCloses #47",
  issues: [{ number: 47, title: "covered" }],
  pullRequests: [{ number: 50, title: "current", headRefName: "fix/current", headRepository: "owner/repo", baseRepository: "owner/repo" }],
});
assert.equal(ready.issueBlockers.length, 0, "covered issue remained a blocker");
assert.equal(ready.pullRequestBlockers.length, 0, "current branch PR remained a blocker");

const blocked = backlogBlockers({
  branch: "fix/current",
  commitMessages: "Closes #47",
  issues: [{ number: 47 }, { number: 48 }],
  pullRequests: [
    { number: 50, headRefName: "fix/current", headRepository: "owner/repo", baseRepository: "owner/repo" },
    { number: 51, headRefName: "fix/other", headRepository: "owner/repo", baseRepository: "owner/repo" },
    { number: 52, headRefName: "fix/current", headRepository: "fork/repo", baseRepository: "owner/repo" },
  ],
});
assert.deepEqual(blocked.issueBlockers.map((item) => item.number), [48], "uncovered issue did not block a push");
assert.deepEqual(blocked.pullRequestBlockers.map((item) => item.number), [51, 52], "unrelated or forked open PR did not block a push");

const invocations = [];
const result = assertGitHubBacklogReady({
  cwd: "/repo",
  git: "git",
  gh: "gh",
  run(command, args, cwd) {
    invocations.push({ command, args, cwd });
    if (command === "git" && args[0] === "branch") return { status: 0, stdout: "fix/current\n" };
    if (command === "git" && args[0] === "log") return { status: 0, stdout: "fix: close race\n\nCloses #47\0" };
    if (command === "gh" && args.at(-1).includes("/issues?")) return { status: 0, stdout: '[[{"number":47,"title":"race","html_url":"https://example/issues/47"},{"number":49,"title":"current","pull_request":{},"html_url":"https://example/pull/49"}]]' };
    if (command === "gh" && args.at(-1).includes("/pulls?")) return { status: 0, stdout: '[[{"number":49,"title":"current","head":{"ref":"fix/current","repo":{"full_name":"owner/repo"}},"base":{"repo":{"full_name":"owner/repo"}},"html_url":"https://example/pull/49"}]]' };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  },
});
assert.match(result.message, /closing issue\(s\): #47/, "passing backlog gate omitted covered issues");
assert(invocations.every((item) => item.cwd === "/repo"), "backlog gate escaped the repository cwd");

assert.throws(() => assertGitHubBacklogReady({
  branch: "fix/current",
  git: "git",
  gh: "gh",
  run(command, args) {
    if (command === "git") return { status: 0, stdout: "no closing references" };
    if (args.at(-1).includes("/issues?")) return { status: 0, stdout: '[[{"number":48,"title":"unhandled issue"}]]' };
    return { status: 0, stdout: '[[{"number":51,"title":"other PR","head":{"ref":"fix/other","repo":{"full_name":"owner/repo"}},"base":{"repo":{"full_name":"owner/repo"}}}]]' };
  },
}), /#48[\s\S]*#51/, "backlog blocker diagnostics omitted issue or PR details");

console.log("GitHub backlog gate test ok");
