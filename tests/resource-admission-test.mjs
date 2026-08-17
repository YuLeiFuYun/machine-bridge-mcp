import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceAdmissionError, ResourceCoordinator, ResourceLease } from "../src/local/resource-admission.mjs";
import { deriveHostRates, evaluateResourceAdmission, resourcePressureSnapshot } from "../src/local/resource-admission-policy.mjs";
import { applyResourceProfileEnv, resourceCommandEffectiveCwd, resourceCommandProfile } from "../src/local/resource-command-profile.mjs";
import { freshResourceHostSnapshot } from "../src/local/resource-host-cache.mjs";
import { readResourceHostSample } from "../src/local/resource-host-sample-file.mjs";
import { sampleDarwinHost, sampleDarwinHostAsync } from "../src/local/resource-host-darwin.mjs";
import { sampleLinuxHost } from "../src/local/resource-host-linux.mjs";
import { aggregateResourceLeases, resourceLeaseAccountingContext, resourceRequestIncrement } from "../src/local/resource-lease-accounting.mjs";
import { unobservedResourceCpu } from "../src/local/resource-cpu-window.mjs";
import { resourceDiskHardFloorBytes, resourceDiskSoftFloorBytes } from "../src/local/resource-disk-headroom.mjs";
import { fitElasticRequestToPressure, isElasticCompilerRequest, markElasticCompilerJobs, preservesCompilerJobs } from "../src/local/resource-elastic-request.mjs";
import { mavenCoreMultiplierPlan } from "../src/local/resource-maven-concurrency.mjs";
import { ninjaJobserverPlan } from "../src/local/resource-ninja-concurrency.mjs";
import { cachedResourceProcessParentSampler, cachedResourceProcessParentSamplerAsync } from "../src/local/resource-process-ancestry-cache.mjs";
import { parseResourceProcessParents, sampleResourceProcessParents } from "../src/local/resource-process-ancestry.mjs";
import { normalizeResourceProjectIdentity, resourceProjectContentionKey, resourceProjectHash, resourceProjectIdentityHash, resourceRequestForProject } from "../src/local/resource-project-key.mjs";
import { sampleResourceHost, sampleResourceHostAsync } from "../src/local/resource-host-snapshot.mjs";
import { validateResourceRequest } from "../src/local/resource-request-contract.mjs";
import { applyResourceProcessPriority } from "../src/local/resource-process-priority.mjs";
import { currentProcessStartTimeMs } from "../src/local/process-identity.mjs";
import { packageName, packageVersion } from "../src/local/package-identity.mjs";
import { releaseProcessResourcesQuietly } from "../src/local/resource-process-admission.mjs";
import { foregroundResourceWaitMs, processSessionResourceWaitMs } from "../src/local/resource-foreground-wait.mjs";
import { releaseControlExecutableIsTrusted } from "../src/local/resource-release-control-executable.mjs";
import { releaseControlWorkspaceForCommand, releaseControlWorkspaceMatches } from "../src/local/resource-release-control-workspace.mjs";
import { RESOURCE_STAGING_BUSY_CODE } from "../src/local/resource-staging-recovery.mjs";
import { withResourceTransactionLock } from "../src/local/resource-transaction-lock.mjs";
import { resourceChangeSignal, resourceRetryDelayMs, resourceSleep, signalResourceChange, waitForResourceChange } from "../src/local/resource-wait.mjs";
import { createResourceWaiter, resourceWaiterProtected, resourceWaiterQueueSnapshot, resourceWaiterRank, selectedResourceWaiter } from "../src/local/resource-waiters.mjs";

const GIB = 1024 ** 3;
let hostSampleReads = 0;
const recoveredHostSample = readResourceHostSample("/synthetic/host-sample.json", {
  readFile: () => {
    hostSampleReads += 1;
    if (hostSampleReads < 4) throw Object.assign(new Error("synthetic host sample generation change"), { code: "MBM_IDENTITY_CHANGED" });
    return Buffer.from('{"sampled_at_ms":1,"sample_scope":"test"}\n');
  },
});
assert.equal(hostSampleReads, 4, "resource host sample did not retry bounded atomic-generation churn");
assert.equal(recoveredHostSample.sample_scope, "test", "resource host sample retry lost the settled generation");
let persistentHostSampleReads = 0;
assert.throws(() => readResourceHostSample("/synthetic/host-sample.json", {
  readFile: () => {
    persistentHostSampleReads += 1;
    throw Object.assign(new Error("persistent host sample generation churn"), { code: "MBM_IDENTITY_CHANGED" });
  },
}), /persistent host sample generation churn/, "persistent resource host sample generation churn did not fail closed");
assert.equal(persistentHostSampleReads, 4, "resource host sample identity retry exceeded its bounded attempt budget");
assert.equal(readResourceHostSample("/synthetic/missing-host-sample.json", {
  optional: true,
  readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
}), null, "optional missing resource host sample was not treated as an empty cache");
assert.throws(() => readResourceHostSample("/synthetic/malformed-host-sample.json", {
  readFile: () => Buffer.from("not-json"),
}), SyntaxError, "resource host sample retry masked malformed cache content");
assert.equal(foregroundResourceWaitMs(60_000), 10_000, "default 60-second foreground work retained the interruption-prone two-second admission window");
assert.equal(foregroundResourceWaitMs(30_000), 6_000, "foreground admission budget did not scale with the execution deadline");
assert.equal(foregroundResourceWaitMs(10_000), 2_000, "short foreground work gained an excessive resource-admission delay");
assert.equal(foregroundResourceWaitMs(1_000), 1_000, "resource admission exceeded the entire short execution deadline");
assert.equal(foregroundResourceWaitMs(60_000, 300_000), 300_000, "explicit diagnostic resource wait was not preserved");
assert.equal(processSessionResourceWaitMs(), 10_000, "process-session startup retained the interruption-prone two-second admission window");
assert.equal(processSessionResourceWaitMs(undefined, { remote: true }), 0,
  "remote process-session startup can still queue behind host pressure until the MCP response budget is consumed");
assert.equal(processSessionResourceWaitMs(1_234), 1_234, "explicit process-session admission wait was not preserved");
assert.equal(processSessionResourceWaitMs(1_234, { remote: true }), 1_234,
  "explicit remote process-session admission wait was silently replaced by the fail-fast default");
assert.throws(() => foregroundResourceWaitMs(60_000, -1), /non-negative/, "negative explicit resource wait was accepted");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseControlOptions = { releaseControlWorkspace: true };
const green = host();
const cargo = resourceCommandProfile("cargo", ["test", "--workspace"]);
let releaseAttempts = 0;
const retryableReleaseLease = new ResourceLease({
  async releaseLease() {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error("transient release failure");
    return true;
  },
}, { lease_id: "retry-release", token: "retry-token" }, cargo);
await assert.rejects(() => retryableReleaseLease.release(), /transient release failure/);
assert.equal(retryableReleaseLease.active, true, "failed durable lease release made the local handle non-retryable");
assert.equal(await retryableReleaseLease.release(), true, "retry after durable lease release failure did not succeed");
assert.equal(retryableReleaseLease.active, false, "successful durable lease release left the local handle active");
assert.equal(await releaseProcessResourcesQuietly({ release: async () => { throw new Error("cleanup failed"); } }), false,
  "best-effort resource cleanup leaked a rejected promise");
assert.equal(cargo.family, "cargo");
assert.equal(cargo.cpu, 3);
assert.equal(isElasticCompilerRequest(cargo), true, "implicit Cargo fan-out was not marked elastic in memory");
assert.equal(JSON.stringify(cargo).includes("elasticCompilerJobs"), false, "elastic compiler marker became JSON-visible");
assert.equal(applyResourceProfileEnv({ PATH: "/bin" }, cargo).CARGO_BUILD_JOBS, "3");
const explicitCargoJobs = resourceCommandProfile("cargo", ["test", "-j5"]);
assert.equal(explicitCargoJobs.cpu, 5);
assert.equal(isElasticCompilerRequest(explicitCargoJobs), false, "explicit Cargo fan-out became elastic");
const environmentCargoJobs = resourceCommandProfile("cargo", ["test"], { environment: { CARGO_BUILD_JOBS: "6" } });
assert.equal(environmentCargoJobs.cpu, 6, "CARGO_BUILD_JOBS was not charged as explicit concurrency");
assert.equal(isElasticCompilerRequest(environmentCargoJobs), false, "explicit CARGO_BUILD_JOBS became elastic");
assert.equal(preservesCompilerJobs(environmentCargoJobs), true, "explicit CARGO_BUILD_JOBS lost its authoritative environment marker");
const cargoCores = availableParallelism();
assert.equal(resourceCommandProfile("cargo", ["test", "--jobs", "default"]).cpu, cargoCores,
  "Cargo --jobs default was not charged at Cargo's logical-CPU default");
assert.equal(resourceCommandProfile("cargo", ["test"], { environment: { CARGO_BUILD_JOBS: "default" } }).cpu, cargoCores,
  "CARGO_BUILD_JOBS=default was not charged at Cargo's logical-CPU default");
if (cargoCores > 1) {
  assert.equal(resourceCommandProfile("cargo", ["test", "-j", "-1"]).cpu, cargoCores - 1,
    "Cargo negative --jobs was not resolved relative to logical CPUs");
  const relativeEnvironment = resourceCommandProfile("cargo", ["test"], { environment: { CARGO_BUILD_JOBS: "-1" } });
  assert.equal(relativeEnvironment.cpu, cargoCores - 1, "negative CARGO_BUILD_JOBS was not resolved relative to logical CPUs");
  assert.equal(preservesCompilerJobs(relativeEnvironment), true, "relative CARGO_BUILD_JOBS lost environment preservation");
}
assert.equal(resourceCommandProfile("cargo", ["test", "-j5"], { environment: { CARGO_BUILD_JOBS: "-1" } }).cpu, 5,
  "Cargo command-line jobs did not override CARGO_BUILD_JOBS");
assert.equal(resourceCommandProfile("cargo", ["test", "--", "-j64"]).cpu, 3,
  "Cargo test-harness arguments after -- were mistaken for Cargo build concurrency");
assert.equal(resourceCommandProfile("cargo", ["test", "-j0"]).unbounded, true, "invalid Cargo zero jobs was silently rewritten to a bounded value");
assert.equal(resourceCommandProfile("cargo", ["test", `-j-${cargoCores}`]).unbounded, true,
  "Cargo relative jobs resolving to zero was silently treated as bounded");
assert.equal(resourceCommandProfile("cargo", ["test", "-j64"]).cpu, 64, "explicit Cargo concurrency was silently under-accounted");
assert.equal(resourceCommandProfile("cargo", ["test", "-j5000"]).unbounded, true, "oversized explicit Cargo fan-out was silently capped below reality");
assert.equal(resourceCommandProfile("cargo", ["test"], { environment: { CARGO_BUILD_JOBS: "5000" } }).unbounded, true,
  "oversized CARGO_BUILD_JOBS was silently treated as an elastic default");
assert.equal(resourceCommandProfile("git", ["status"]).resource_class, "adaptive",
  "caller-controlled Git metadata was trusted as helper-free fixed control-plane work");
const diskReclaim = resourceCommandProfile("/bin/rm", ["-rf", "/tmp/known-regenerable-cache"]);
assert.equal(diskReclaim.family, "disk-reclaim", "trusted direct delete executable was not recognized as disk reclaim");
assert.equal(diskReclaim.resource_class, "io");
assert.equal(diskReclaim.disk_reserve_bytes, 0);
assert.notEqual(resourceCommandProfile("rm", ["-rf", "/tmp/cache"]).family, "disk-reclaim",
  "PATH-resolved executable could spoof the disk-reclaim admission class");
assert.notEqual(resourceCommandProfile("/bin/zsh", ["-c", "rm -rf /tmp/cache"]).family, "disk-reclaim",
  "shell payload was trusted as a proof that execution can only reclaim disk");
for (const [command, args] of [["/bin/ps", ["-axo", "pid=,ppid="]], ["/usr/bin/uptime", []], ["/bin/sleep", ["0"]]]) {
  assert.equal(resourceCommandProfile(command, args).heavy, false, `${command} trusted absolute probe should bypass heavy admission`);
}
for (const [command, args] of [
  ["ps", ["-axo", "pid=,ppid="]], ["uptime", []], ["sleep", ["0"]],
  ["stat", ["README.md"]], ["df", ["-k", "."]], ["which", ["node"]], ["printf", ["%s", "x"]],
  ["wc", ["-l", "README.md"]], ["rg", ["needle", "."]], ["grep", ["-R", "needle", "."]],
  ["find", [".", "-type", "f"]], ["awk", ["BEGIN { system(\"make\") }"]],
  ["osascript", ["-e", "do shell script \"make\""]], ["open", ["-a", "Xcode"]],
]) {
  assert.equal(resourceCommandProfile(command, args).resource_class, "adaptive",
    `${command} retained a light bypass despite unbounded I/O or child-execution semantics`);
}
assert.equal(resourceCommandProfile("du", ["-sh", "."]).resource_class, "adaptive", "recursive disk walk was incorrectly treated as a light metadata probe");
assert.equal(resourceCommandProfile("/bin/zsh", ["-f", "-c", "/bin/ps -axo pid=,ppid="]).resource_class, "adaptive",
  "arbitrary shell regained a zero-resource bypass from a trusted-looking inner executable");
assert.equal(resourceCommandProfile("/bin/zsh", ["-f", "-c", "ps -axo pid=; uptime"]).resource_class, "adaptive",
  "arbitrary shell composition regained a blanket zero-resource bypass");
for (const payload of [
  "echo ready; chmod 644 marker",
  "echo ready & python3 -c pass",
  "echo `python3 -c pass`",
  "echo $(python3 -c pass)",
  "echo <(python3 -c pass)",
  "echo *.tar",
  "echo ${PATH}",
  "PATH=/tmp ps",
  "env PATH=/tmp ps",
  "echo ready;PATH=/tmp ps",
  "printf -v PATH /tmp; ps",
]) {
  assert.notEqual(resourceCommandProfile("/bin/zsh", ["-f", "-c", payload]).resource_class, "light",
    `arbitrary shell payload regained zero-resource admission: ${payload}`);
}
assert.equal(resourceCommandProfile("/bin/zsh", ["-f", "-c", "xcodebuild test"]).unbounded, true);
for (const flag of ["-help", "-usage"]) assert.equal(resourceCommandProfile("xcodebuild", [flag]).heavy, false, `xcodebuild ${flag} was rewritten as a build`);
const xcodeQuery = resourceCommandProfile("xcodebuild", ["-showBuildSettings"]);
assert.equal(xcodeQuery.family, "xcode-query"); assert.equal(xcodeQuery.resource_class, "adaptive"); assert.equal(xcodeQuery.cpu, 0.75);
const xcodePackages = resourceCommandProfile("xcodebuild", ["-resolvePackageDependencies"]);
assert.equal(xcodePackages.family, "xcode-package-resolution"); assert.equal(xcodePackages.resource_class, "mixed");
assert.equal(xcodePackages.cpu, 2); assert.equal(xcodePackages.io, 0.65); assert.equal(xcodePackages.disk_reserve_bytes, 4 * GIB); assert.equal(xcodePackages.serialize_project, true);
const xcodeArtifact = resourceCommandProfile("xcodebuild", ["-exportArchive"]);
assert.equal(xcodeArtifact.family, "xcode-artifact"); assert.equal(xcodeArtifact.resource_class, "io");
assert.equal(xcodeArtifact.io, 0.9); assert.equal(xcodeArtifact.disk_reserve_bytes, 8 * GIB); assert.equal(xcodeArtifact.serialize_project, true);
const xcodeMaintenance = resourceCommandProfile("xcodebuild", ["-downloadPlatform", "iOS"]);
assert.equal(xcodeMaintenance.family, "xcode-maintenance"); assert.equal(xcodeMaintenance.unbounded, true);
assert.equal(xcodeMaintenance.io, 0.95); assert.equal(xcodeMaintenance.disk_reserve_bytes, 8 * GIB); assert.equal(xcodeMaintenance.serialize_project, false);
const xcodeDelete = resourceCommandProfile("xcodebuild", ["-deleteComponent", "MetalToolchain"]);
assert.equal(xcodeDelete.family, "xcode-maintenance"); assert.equal(xcodeDelete.resource_class, "io");
assert.equal(xcodeDelete.unbounded, false); assert.equal(xcodeDelete.disk_reserve_bytes, 0, "Xcode component deletion invented future disk consumption");
for (const request of [xcodeQuery, xcodePackages, xcodeArtifact, xcodeMaintenance, xcodeDelete]) assert.equal(request.compiler_jobs, null, `${request.family} invented compiler fan-out`);
const implicitXcodeBuild = resourceCommandProfile("xcodebuild", ["build"]);
assert.equal(implicitXcodeBuild.cpu, 3, "implicit Xcode build lost the local compiler ceiling");
assert.equal(isElasticCompilerRequest(implicitXcodeBuild), true, "implicit Xcode build fan-out was not elastic");
assert.equal(resourceCommandProfile("xcodebuild", ["build", "-jobs", "2"]).cpu, 2, "explicit Xcode -jobs was not charged exactly");
for (const value of ["-jobs=+4", "-jobs=0", "-jobs=abc"]) assert.equal(resourceCommandProfile("xcodebuild", ["build", value]).unbounded, true,
  `Xcode non-option equals form ${value} was mistaken for a native -jobs hard bound`);
for (const args of [["build", "-jobs", "0"], ["build", "-jobs", "-1"], ["build", "-jobs"], ["build", "-jobs", "2", "-jobs", "3"]]) {
  const invalidXcode = resourceCommandProfile("xcodebuild", args);
  assert.equal(invalidXcode.family, "build-validation", `pre-build Xcode jobs error ${args.join(" ")} waited for heavy capacity`);
  assert.equal(invalidXcode.heavy, false, `pre-build Xcode jobs error ${args.join(" ")} consumed heavy capacity`);
}
assert.equal(resourceCommandProfile("xcodebuild", ["build", "-jobs", "2.5"]).unbounded, true,
  "noncanonical Xcode jobs accepted by the native parser were mistaken for validation-only input");
assert.equal(resourceCommandProfile("xcodebuild", ["build", "-jobs2"]).unbounded, true,
  "undocumented Xcode jobs spelling was guessed into a hard concurrency bound");
assert.equal(resourceCommandProfile("xcodebuild", ["build", "-jobs", "5000"]).unbounded, true,
  "oversized Xcode build concurrency was silently capped below reality");
const explicitXcodeTest = resourceCommandProfile("xcodebuild", ["test", "-jobs", "2"]);
assert.equal(explicitXcodeTest.unbounded, true, "Xcode test was bounded only by build-operation jobs despite independent test runners");
assert.equal(explicitXcodeTest.compiler_jobs, 2, "Xcode test lost its independent build-phase cap while remaining overall unbounded");
const implicitXcodeTest = resourceCommandProfile("xcodebuild", ["test"]);
assert.equal(implicitXcodeTest.unbounded, true, "implicit Xcode test ignored independent runner/destination fan-out");
assert.equal(implicitXcodeTest.compiler_jobs, 3, "implicit Xcode test lost its build-phase compiler ceiling");
assert.equal(isElasticCompilerRequest(implicitXcodeTest), false, "overall-unbounded Xcode test incorrectly applied compiler elasticity to total CPU demand");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "swift test"]).unbounded, true,
  "shell-wrapped implicit Swift fan-out was treated as controllable without argv injection");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "swift test -j 2"]).cpu, 2,
  "shell-wrapped explicit Swift fan-out was not reflected in admission");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "swift test -j auto"]).unbounded, true,
  "shell-wrapped nonnumeric Swift fan-out was treated as bounded");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "swift test -j 2; make -j8 all"]).unbounded, true,
  "multi-segment shell orchestration was bounded by only its Swift segment");
assert.equal(isElasticCompilerRequest(resourceCommandProfile("swift", ["test"])), true, "direct implicit Swift fan-out was not elastic");
assert.equal(resourceCommandProfile("swift", ["test", "-j", "2", "--jobs=8"]).cpu, 8,
  "repeated SwiftPM jobs did not use the final scalar option value");
assert.equal(resourceCommandProfile("swift", ["test", "-j=7"]).cpu, 7, "SwiftPM short option with equals was not charged exactly");
assert.equal(resourceCommandProfile("swift", ["test", "--jobs=", "6"]).cpu, 6,
  "SwiftPM empty attached jobs value did not consume the following argv value like Argument Parser");
assert.equal(resourceCommandProfile("swift", ["test", "--jobs=+8"]).cpu, 8, "SwiftPM UInt32 jobs rejected an accepted leading plus sign");
assert.equal(resourceCommandProfile("swift", ["test", "--jobs", "0"]).unbounded, true,
  "SwiftPM zero jobs did not preserve llbuild's hardware-concurrency default");
assert.equal(resourceCommandProfile("swift", ["test", "--jobs=5000", "-j", "3"]).cpu, 3,
  "a valid oversized SwiftPM jobs value could not be overridden by a later bounded value");
for (const args of [["test", "-j8"], ["test", "-j=", "6"], ["test", "-j", "-1"], ["test", "--jobs=4294967296"], ["test", "--jobs=oops"]]) {
  const invalidSwift = resourceCommandProfile("swift", args);
  assert.equal(invalidSwift.family, "build-validation", `invalid SwiftPM jobs ${args.join(" ")} waited for heavy build capacity`);
  assert.equal(invalidSwift.heavy, false, `invalid SwiftPM jobs ${args.join(" ")} consumed heavy admission capacity`);
}
assert.equal(resourceCommandProfile("swift", ["test", "--jobs=2", "--", "--jobs=9"]).cpu, 2,
  "SwiftPM arguments after the terminator changed build fan-out accounting");
const backgroundPriority = applyResourceProcessPriority("cargo", ["test"], { ...cargo, priority: "background" });
if (process.platform === "win32") assert.equal(backgroundPriority.command, "cargo");
else assert.deepEqual(backgroundPriority, { command: "/usr/bin/nice", args: ["-n", "5", "cargo", "test"] });
assert.equal(applyResourceProcessPriority("cargo", ["test"], { ...cargo, priority: "interactive" }).command, "cargo");
const unboundedPriority = applyResourceProcessPriority("zsh", ["-c", "make all"], { heavy: true, priority: "interactive", unbounded: true });
if (process.platform === "win32") assert.equal(unboundedPriority.command, "zsh");
else assert.deepEqual(unboundedPriority, { command: "/usr/bin/nice", args: ["-n", "2", "zsh", "-c", "make all"] });
assert.equal(resourceCommandProfile("pytest", ["-q", "-n", "4"]).cpu, 4);
assert.equal(resourceCommandProfile("pytest", ["-q", "-n4"]).cpu, 4, "compact pytest -n worker count was not reflected in admission");
assert.equal(resourceCommandProfile("pytest", ["-q", "-n", "auto"]).unbounded, true, "dynamic pytest fan-out was under-accounted as one worker");
assert.equal(resourceCommandProfile("pytest", ["-q", "-nauto", "--maxprocesses=3"]).cpu, 3,
  "compact pytest auto fan-out ignored its explicit maximum worker cap");
assert.equal(resourceCommandProfile("pytest", ["-q", "-n", "0"]).cpu, 1, "pytest -n 0 was not treated as single-process execution");
assert.equal(resourceCommandProfile("pytest", ["-q", "-n", "auto", "--maxprocesses=3"]).cpu, 3,
  "pytest auto fan-out ignored its explicit maximum worker cap");
assert.equal(resourceCommandProfile("pytest", ["-q", "--numprocesses=logical", "--maxprocesses", "2"]).cpu, 2,
  "pytest logical fan-out ignored its explicit maximum worker cap");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "pytest -n auto --maxprocesses=5 tests"]).cpu, 5,
  "shell-wrapped pytest auto fan-out ignored its explicit maximum worker cap");
assert.equal(resourceCommandProfile("pytest", ["-q", "-n", "auto", "--maxprocesses=5000"]).unbounded, true,
  "oversized pytest maxprocesses was silently capped below reality");
assert.deepEqual(
  { family: resourceCommandProfile("make", ["all"]).family, cpu: resourceCommandProfile("make", ["all"]).cpu, unbounded: resourceCommandProfile("make", ["all"]).unbounded },
  { family: "generic-build", cpu: 3, unbounded: false },
  "direct generic build was not converted to a bounded worker profile",
);
assert.equal(resourceCommandProfile("make", ["-j8", "all"]).cpu, 8, "explicit compact make concurrency was not reflected in admission");
assert.equal(resourceCommandProfile("make", ["-kj8", "all"]).cpu, 8, "clustered GNU make -j concurrency was not reflected in admission");
assert.equal(resourceCommandProfile("make", ["-j2", "-kj8", "all"]).cpu, 8, "GNU make's last clustered -j option did not win admission accounting");
assert.equal(resourceCommandProfile("make", ["-kj8", "-j2", "all"]).cpu, 2, "GNU make's later plain -j option did not win admission accounting");
assert.equal(resourceCommandProfile("make", ["-j", "all"]).unbounded, true, "unlimited make -j was under-accounted as the default worker cap");
assert.deepEqual(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin"),
  { jobs: null, elastic: false, unbounded: true, preserve: true },
  "POSIX Ninja jobserver was treated as hard-bounded even though client initialization can fall back to native parallelism");
assert.deepEqual(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "--jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin"),
  { jobs: null, elastic: false, unbounded: true, preserve: true }, "Ninja jobserver with an unknown token ceiling was not fail-closed as unbounded");
assert.equal(ninjaJobserverPlan(["ninja"], {}, 1024, "darwin"), null, "Ninja invented jobserver state without MAKEFLAGS");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "--jobserver-auth=fifo:" }, 1024, "darwin"), null,
  "Ninja accepted an empty POSIX FIFO jobserver path");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=3,4" }, 1024, "darwin"), null,
  "POSIX Ninja treated an unsupported pipe jobserver as authoritative");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "n -j8 --jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin"), null,
  "Ninja ignored MAKEFLAGS dry-run flag letters when deciding jobserver use");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/ninja-jobs --jobserver-fds=3,4" }, 1024, "darwin"), null,
  "Ninja did not honor the last recognized pipe jobserver descriptor over an earlier FIFO auth");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-fds=3,4 --jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin")?.unbounded, true,
  "Ninja did not honor a later FIFO auth over an earlier pipe descriptor as cooperative/unbounded admission");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-fds=invalid --jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin"), null,
  "Ninja accepted MAKEFLAGS after a malformed jobserver-fds argument that its parser rejects");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=-1,4" }, 1024, "darwin"), null,
  "Ninja treated a disabled negative-descriptor jobserver as active");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=Global\\NinjaJobs" }, 1024, "win32")?.unbounded, true,
  "Windows Ninja semaphore jobserver was not preserved as cooperative/unbounded admission");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=3,4" }, 1024, "win32"), null,
  "Windows Ninja treated POSIX pipe descriptors as semaphore jobserver authentication");
assert.equal(ninjaJobserverPlan(["ninja"], { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/jobs" }, 1024, "win32"), null,
  "Windows Ninja treated POSIX FIFO authentication as a semaphore jobserver");
assert.equal(ninjaJobserverPlan(["ninja", "-n"], { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/ninja-jobs" }, 1024, "darwin"), null,
  "Ninja dry-run incorrectly preserved a jobserver it does not use");
const ninjaJobserverRequest = resourceCommandProfile("ninja", ["all"], { environment: { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/ninja-jobs" } });
const explicitNinjaJobs = resourceCommandProfile("ninja", ["-j8", "all"], { environment: { MAKEFLAGS: "-j4 --jobserver-auth=fifo:/tmp/ninja-jobs" } });
assert.equal(explicitNinjaJobs.cpu, 8, "explicit Ninja -j did not remain the hard local worker bound that disables jobserver use");
assert.equal(explicitNinjaJobs.unbounded, false, "explicit Ninja -j was incorrectly treated as cooperative jobserver fan-out");
assert.equal(resourceCommandProfile("ninja", ["-j2", "-j8", "all"]).cpu, 8,
  "repeated Ninja -j options did not use the final getopt value");
assert.equal(resourceCommandProfile("ninja", ["-j8", "-j2", "all"]).cpu, 2,
  "a later smaller Ninja -j did not replace the earlier worker count");
assert.equal(resourceCommandProfile("ninja", ["-j0", "all"]).unbounded, true,
  "Ninja -j0 infinity was mistaken for a bounded or invalid worker count");
for (const args of [["-j-1", "all"], ["-j", "oops", "all"], ["--jobs=8", "all"]]) {
  const invalidNinja = resourceCommandProfile("ninja", args);
  assert.equal(invalidNinja.family, "build-validation", `invalid Ninja concurrency ${args.join(" ")} was queued as heavy work`);
  assert.equal(invalidNinja.heavy, false, `invalid Ninja concurrency ${args.join(" ")} consumed heavy admission capacity`);
}
if (process.platform !== "win32") {
  assert.equal(ninjaJobserverRequest.unbounded, true,
    "Ninja FIFO jobserver was treated as a hard CPU bound even though jobserver client initialization can fail open to native parallelism");
  assert.equal(preservesCompilerJobs(ninjaJobserverRequest), true, "Ninja jobserver request was not preserved as authoritative");
}
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "--parallel"]).unbounded, true,
  "value-less cmake --parallel was under-accounted as the native-tool default");
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "-j2", "--parallel", "8"]).cpu, 8,
  "repeated CMake parallel options did not use the final parsed value");
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "--parallel8"]).cpu, 8,
  "CMake's no-separator --parallel value form was not charged");
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "-j=7"]).cpu, 7,
  "CMake -j=value concurrency was not charged");
const invalidCmakeJobs = resourceCommandProfile("cmake", ["--build", "build", "--parallel=0"]);
assert.equal(invalidCmakeJobs.family, "build-validation", "invalid CMake CLI jobs were queued as a heavy build");
assert.equal(invalidCmakeJobs.heavy, false, "invalid CMake CLI jobs consumed heavy admission capacity");
const cmakeEnvironmentJobs = resourceCommandProfile("cmake", ["--build", "build"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: "8" } });
assert.equal(cmakeEnvironmentJobs.cpu, 8, "CMAKE_BUILD_PARALLEL_LEVEL was not charged as explicit CMake concurrency");
assert.equal(isElasticCompilerRequest(cmakeEnvironmentJobs), false, "explicit CMake environment concurrency became elastic");
assert.equal(preservesCompilerJobs(cmakeEnvironmentJobs), true, "explicit CMake environment concurrency was not marked authoritative");
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "--parallel=4"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: "8" } }).cpu, 4,
  "CMake CLI concurrency did not override CMAKE_BUILD_PARALLEL_LEVEL");
assert.equal(resourceCommandProfile("cmake", ["--build", "build"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: "" } }).unbounded, true,
  "empty CMAKE_BUILD_PARALLEL_LEVEL native-tool concurrency was overwritten by the default bound");
for (const value of ["0", "invalid", "2147483648"]) {
  const invalidEnvironment = resourceCommandProfile("cmake", ["--build", "build"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: value } });
  assert.equal(invalidEnvironment.family, "build-validation", `invalid CMAKE_BUILD_PARALLEL_LEVEL=${value} was queued as heavy work`);
}
assert.equal(resourceCommandProfile("cmake", ["--build", "--preset", "fast"]).unbounded, true,
  "uninspected CMake build preset jobs/nativeToolOptions were mistaken for a hard local bound");
assert.equal(resourceCommandProfile("cmake", ["--build", "--preset", "fast", "--parallel=2"]).unbounded, true,
  "CMake preset nativeToolOptions were ignored when claiming an explicit CLI hard bound");
assert.equal(resourceCommandProfile("cmake", ["--build", "build", "--parallel=2", "--", "-j8"]).unbounded, true,
  "CMake native-tool options were treated as if generator-specific fan-out could not override the CMake layer");
assert.equal(resourceCommandProfile("cmake", ["--build", "--preset", "fast"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: "invalid" } }).unbounded, true,
  "CMake preset recovery from invalid parent environment was incorrectly treated as pre-build validation");
assert.equal(isElasticCompilerRequest(resourceCommandProfile("make", ["all"])), true, "implicit generic build fan-out was not elastic");
assert.equal(isElasticCompilerRequest(resourceCommandProfile("make", ["-j8", "all"])), false, "explicit generic build fan-out became elastic");
assert.equal(resourceCommandProfile("mvn", ["-T4", "test"]).cpu, 4, "explicit compact Maven concurrency was not reflected in admission");
const mavenCoreJobs = Math.max(1, Math.trunc(2.5 * availableParallelism()));
const mavenCoreRequest = resourceCommandProfile("mvn", ["-T2.5C", "test"]);
assert.equal(mavenCoreRequest.cpu, mavenCoreJobs, "Maven core-multiplier concurrency did not match Maven's available-processors calculation");
assert.equal(mavenCoreRequest.compiler_jobs, mavenCoreJobs, "Maven core-multiplier worker count was not propagated to admission");
assert.equal(isElasticCompilerRequest(mavenCoreRequest), false, "explicit Maven core multiplier became elastic");
assert.equal(resourceCommandProfile("mvn", ["-T0.0001C", "test"]).cpu, 1, "small positive Maven core multiplier did not preserve Maven's one-thread floor");
assert.equal(resourceCommandProfile("mvn", ["-T0C", "test"]).unbounded, true, "invalid Maven core multiplier was under-accounted as bounded");
assert.equal(mavenCoreMultiplierPlan(["mvn", "test"]), null, "ordinary Maven invocation was misclassified as a core multiplier");
assert.equal(mavenCoreMultiplierPlan(["mvn", "--threads", "2.5C"])?.jobs, mavenCoreJobs,
  "Maven --threads value form diverged from compact -T core-multiplier accounting");
assert.equal(mavenCoreMultiplierPlan(["mvn", "--threads=2.5C"])?.jobs, mavenCoreJobs,
  "Maven --threads=value form diverged from compact -T core-multiplier accounting");
assert.equal(mavenCoreMultiplierPlan(["mvn", "-T2.5C"], 1)?.unbounded, true,
  "Maven core multiplier above the admission maximum was silently capped");
const mavenArgsJobs = resourceCommandProfile("mvn", ["test"], { environment: { MAVEN_ARGS: "-B -T6" } });
assert.equal(mavenArgsJobs.cpu, 6, "MAVEN_ARGS thread count was not charged before CLI arguments");
assert.equal(preservesCompilerJobs(mavenArgsJobs), true, "MAVEN_ARGS thread count was not preserved as authoritative");
assert.equal(resourceCommandProfile("mvn", ["-T2", "test"], { environment: { MAVEN_ARGS: "-T6" } }).cpu, 6,
  "Maven's prepended MAVEN_ARGS did not retain first-thread-option precedence over later CLI -T");
assert.equal(resourceCommandProfile("mvn", ["-T2", "test"], { environment: { MAVEN_ARGS: "-B" } }).cpu, 2,
  "Maven CLI -T was lost when MAVEN_ARGS contained no thread option");
assert.equal(resourceCommandProfile("mvn", ["test"], { environment: { MAVEN_ARGS: "-T2C" } }).cpu,
  Math.max(1, 2 * availableParallelism()), "MAVEN_ARGS core multiplier was not charged using Maven's core semantics");
assert.equal(resourceCommandProfile("mvn", ["test"], { environment: { MAVEN_ARGS: "-T0" } }).unbounded, true,
  "invalid MAVEN_ARGS thread count was under-accounted as bounded");
assert.equal(resourceCommandProfile("./gradlew", ["test"]).cpu, 3, "Gradle wrapper bypassed bounded direct-build admission");
assert.equal(resourceCommandProfile("./mvnw", ["test"]).cpu, 3, "Maven wrapper bypassed bounded direct-build admission");
const makeEnvironmentJobs = resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "-j8" } });
assert.equal(makeEnvironmentJobs.cpu, 8, "MAKEFLAGS concurrency was not charged as explicit make fan-out");
assert.equal(preservesCompilerJobs(makeEnvironmentJobs), true, "MAKEFLAGS concurrency was not preserved as authoritative");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "j8" } }).cpu, 8,
  "MAKEFLAGS without a leading dash did not follow GNU make's implicit-dash option parsing");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "ksj8" } }).cpu, 8,
  "MAKEFLAGS short-option cluster lost its compact -j worker count");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { GNUMAKEFLAGS: "-j7" } }).cpu, 7,
  "GNUMAKEFLAGS concurrency was ignored before MAKEFLAGS parsing");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { GNUMAKEFLAGS: "-j7", MAKEFLAGS: "-j4" } }).cpu, 4,
  "later MAKEFLAGS concurrency did not override GNUMAKEFLAGS as GNU make parses it");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "-j" } }).unbounded, true,
  "unlimited MAKEFLAGS concurrency was under-accounted");
assert.equal(resourceCommandProfile("make", ["-j2", "all"], { environment: { MAKEFLAGS: "-j8" } }).cpu, 2,
  "make command-line concurrency did not override MAKEFLAGS accounting");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "--jobserver-auth=fifo:/tmp/jobs" } }).unbounded, true,
  "inherited GNU make jobserver was overwritten by an invented local bound");
assert.equal(resourceCommandProfile("make", ["--jobs=6", "all"]).cpu, 6,
  "GNU make long --jobs=value concurrency was not reflected in admission");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "--jobs 5" } }).cpu, 5,
  "GNU make MAKEFLAGS --jobs value form was not reflected in admission");
assert.equal(resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "--jobserver-fds=3,4" } }).unbounded, true,
  "legacy GNU make jobserver-fds state was overwritten by an invented local bound");
assert.equal(resourceCommandProfile("make", ["--jobs=0", "all"]).unbounded, true,
  "invalid zero GNU make job count was under-accounted as bounded");
const goEnvironmentJobs = resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "-p=6" } });
assert.equal(goEnvironmentJobs.cpu, 6, "GOFLAGS -p concurrency was not charged as explicit Go fan-out");
assert.equal(preservesCompilerJobs(goEnvironmentJobs), true, "GOFLAGS concurrency was not preserved as authoritative");
assert.equal(resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "'-p=5'" } }).cpu, 5,
  "single-quoted GOFLAGS entry was not parsed with Go's quoted flag semantics");
assert.equal(resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "\"-p=4\"" } }).cpu, 4,
  "double-quoted GOFLAGS entry was not parsed with Go's quoted flag semantics");
for (const invalidGoFlags of ["-p", "-p=0", "'-p=5"]) {
  const invalidGo = resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: invalidGoFlags } });
  assert.equal(invalidGo.family, "build-validation", `invalid GOFLAGS ${invalidGoFlags} was queued as a heavy build instead of pre-build validation`);
  assert.equal(invalidGo.heavy, false, `invalid GOFLAGS ${invalidGoFlags} still consumed heavy admission capacity`);
}
assert.equal(resourceCommandProfile("go", ["test", "-p", "2", "./..."], { environment: { GOFLAGS: "-p=6" } }).cpu, 2,
  "Go command-line -p did not override GOFLAGS accounting");
assert.equal(resourceCommandProfile("go", ["test", "-p=8", "./..."], { environment: { GOFLAGS: "-p=0" } }).cpu, 8,
  "a later valid Go command-line -p did not recover from an overridable zero GOFLAGS value");
assert.equal(resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "-p=0 -p=8" } }).cpu, 8,
  "repeated GOFLAGS -p values did not use the final valid value");
assert.equal(resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "-p=8 -p=0" } }).family, "build-validation",
  "a final zero GOFLAGS -p was not retained for Go's pre-build positive-integer validation");
assert.equal(resourceCommandProfile("go", ["test", "-p=8", "./..."], { environment: { GOFLAGS: "-p=oops" } }).family, "build-validation",
  "fatal non-numeric GOFLAGS -p was incorrectly recoverable by a later command-line value");
assert.equal(resourceCommandProfile("go", ["test", "-p", "2", "-p", "8", "./..."]).cpu, 8,
  "repeated Go command-line -p options did not use the final flag value");
assert.equal(resourceCommandProfile("go", ["test", "-p=0", "-p=8", "./..."]).cpu, 8,
  "a later direct Go -p did not override an earlier numeric value that only fails final BuildInit validation");
assert.equal(resourceCommandProfile("go", ["test", "-p=oops", "-p=8", "./..."]).family, "build-validation",
  "a direct non-numeric Go -p was incorrectly treated as recoverable after flag parsing would already fail");
assert.equal(resourceCommandProfile("go", ["test", "--p=7", "./..."]).cpu, 7,
  "Go --p=value form was not charged as explicit fan-out");
assert.equal(resourceCommandProfile("go", ["test", "-p=5000", "./..."]).unbounded, true,
  "valid Go concurrency above the modeled maximum was mistaken for an invalid pre-build request");
for (const args of [["test", "-p=0", "./..."], ["test", "-p", "-2", "./..."], ["test", "-p8", "./..."]]) {
  const invalidGo = resourceCommandProfile("go", args);
  assert.equal(invalidGo.family, "build-validation", `invalid direct Go concurrency ${args.join(" ")} was queued as a heavy build`);
  assert.equal(invalidGo.heavy, false, `invalid direct Go concurrency ${args.join(" ")} still consumed heavy admission capacity`);
}
assert.equal(resourceCommandProfile("go", ["test", "./...", "-p=9"]).cpu, 9,
  "Go test build flags after the package list were not recognized by its custom parser semantics");
for (const args of [["test", "-args", "-p=9"], ["test", "--args", "-p=9"], ["test", "--", "-p=9"]]) {
  assert.equal(resourceCommandProfile("go", args).cpu, 3,
    `Go test binary arguments after ${args[1]} were misclassified as build fan-out`);
}
assert.equal(resourceCommandProfile("go", ["build", "./...", "-p=9"]).cpu, 3,
  "Go build arguments after the first package operand were incorrectly parsed as command flags");
assert.equal(resourceCommandProfile("go", ["test", "-run", "-p=0", "./..."]).unbounded, true,
  "a possible go test flag value was mistaken for an invalid -p and allowed to bypass heavy admission");
assert.equal(resourceCommandProfile("go", ["build", "-o", "-p=0", "./..."]).unbounded, true,
  "a possible go build flag value was mistaken for an invalid -p and allowed to bypass heavy admission");
assert.equal(resourceCommandProfile("go", ["test", "./...", "-p=8", "literal-test-arg", "-p=0"]).cpu, 8,
  "Go test parsing continued past a positional test argument and replaced the real build fan-out");
const gradleEnvironmentJobs = resourceCommandProfile("./gradlew", ["test"], { environment: { GRADLE_OPTS: "-Dorg.gradle.workers.max=6" } });
assert.equal(gradleEnvironmentJobs.cpu, 6, "GRADLE_OPTS worker property was not charged as explicit fan-out");
assert.equal(preservesCompilerJobs(gradleEnvironmentJobs), true, "GRADLE_OPTS worker property was not preserved as authoritative");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "-Dorg.gradle.workers.max=7" } }).cpu, 7,
  "JAVA_OPTS worker property was not charged as client-JVM Gradle configuration");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "\"-Dorg.gradle.workers.max=8\"" } }).cpu, 8,
  "quoted JAVA_OPTS worker property did not follow the wrapper's JVM-option splitting");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: {
  JAVA_OPTS: "-Dorg.gradle.workers.max=7", GRADLE_OPTS: "-Dorg.gradle.workers.max=6",
} }).cpu, 6, "GRADLE_OPTS did not retain wrapper-order precedence over JAVA_OPTS system properties");
const gradleSystemJobs = resourceCommandProfile("./gradlew", ["-Dorg.gradle.workers.max=5", "test"], { environment: { GRADLE_OPTS: "-Dorg.gradle.workers.max=6" } });
assert.equal(gradleSystemJobs.cpu, 5, "Gradle command-line worker property did not override GRADLE_OPTS accounting");
assert.equal(preservesCompilerJobs(gradleSystemJobs), true, "Gradle worker system property was not preserved as authoritative");
assert.equal(resourceCommandProfile("./gradlew", ["-Dorg.gradle.workers.max=5", "-Dorg.gradle.workers.max=9", "test"]).cpu, 9,
  "repeated Gradle system properties did not use the final map value");
assert.equal(resourceCommandProfile("./gradlew", ["--system-prop=org.gradle.workers.max=8", "test"]).cpu, 8,
  "Gradle --system-prop worker property was not charged");
assert.equal(resourceCommandProfile("./gradlew", ["--max-workers", "5", "test"]).cpu, 5,
  "Gradle separated --max-workers value was not charged");
assert.equal(resourceCommandProfile("./gradlew", ["--max-workers=4", "-Dorg.gradle.workers.max=5", "test"]).cpu, 4,
  "Gradle --max-workers did not retain precedence over the worker system property");
for (const invalidGradle of [
  resourceCommandProfile("./gradlew", ["--max-workers=0", "test"]),
  resourceCommandProfile("./gradlew", ["--max-workers", "bad", "test"]),
  resourceCommandProfile("./gradlew", ["--max-workers=2", "--max-workers=8", "test"]),
  resourceCommandProfile("./gradlew", ["test"], { environment: { GRADLE_OPTS: "-Dorg.gradle.workers.max=0" } }),
  resourceCommandProfile("./gradlew", ["-Dorg.gradle.workers.max=bad", "test"]),
  resourceCommandProfile("./gradlew", ["--max-workers=4", "test"], { environment: { JAVA_OPTS: "-Dorg.gradle.workers.max=bad" } }),
]) {
  assert.equal(invalidGradle.family, "build-validation", "Gradle pre-build worker validation was queued as heavy work");
  assert.equal(invalidGradle.heavy, false, "Gradle pre-build worker validation consumed heavy admission capacity");
}
assert.equal(resourceCommandProfile("./gradlew", ["--max-workers=5000", "test"]).unbounded, true,
  "valid Gradle concurrency above the modeled maximum was mistaken for invalid input");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "-Dorg.gradle.workers.max=5000" } }).unbounded, true,
  "valid Gradle system-property concurrency above the modeled maximum was mistaken for invalid input");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "-Xmx512m" } }).cpu, 3,
  "unrelated JAVA_OPTS disabled the implicit elastic Gradle ceiling");
assert.equal(resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "'-Dorg.gradle.workers.max=8" } }).unbounded, true,
  "malformed Gradle JVM-option quoting was silently replaced by the default worker cap");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "make all"]).unbounded, true, "shell-wrapped generic build was rewritten as if its fan-out were controllable");
const scriptHeavy = resourceCommandProfile("sh", ["scripts/release_gate.sh"]);
assert.equal(scriptHeavy.family, "script-heavy");
assert.equal(scriptHeavy.resource_class, "mixed");
assert.equal(scriptHeavy.cpu, 2.5);
assert.equal(scriptHeavy.unbounded, false);
assert.equal(resourceCommandProfile("/usr/bin/python3", ["script.py"]).resource_class, "adaptive");
assert.equal(resourceCommandProfile("node", ["scripts/coverage-check.mjs"]).family, "script-heavy", "direct Node orchestration script was under-accounted");
assert.equal(resourceCommandProfile("node", ["scripts/run-tests.mjs"]).family, "script-heavy", "plural test script segment was not classified as orchestration");
const verificationPlan = resourceCommandProfile("node", ["scripts/run-checks.mjs"], { environment: { MBM_CHECK_CONCURRENCY: "3" } });
assert.equal(verificationPlan.family, "verification-plan", "verification runner was not given its own fan-out resource profile");
assert.equal(verificationPlan.cpu, 3, "verification runner ignored its configured internal concurrency");
assert.equal(isElasticCompilerRequest(verificationPlan), false, "explicit verification fan-out became elastic");
const implicitVerificationPlan = resourceCommandProfile("node", ["scripts/run-checks.mjs"]);
assert.equal(isElasticCompilerRequest(implicitVerificationPlan), implicitVerificationPlan.compiler_jobs > 1,
  "implicit verification fan-out did not preserve elastic/default distinction");
assert.equal(applyResourceProfileEnv({}, implicitVerificationPlan).MBM_CHECK_CONCURRENCY, String(implicitVerificationPlan.compiler_jobs),
  "verification plan did not enforce the fan-out charged by admission");
assert.equal(resourceCommandProfile("npm", ["run", "check:full"], { environment: { MBM_CHECK_CONCURRENCY: "4" } }).cpu, 4,
  "npm verification wrapper under-accounted its child-process fan-out");
const emptyVerificationConcurrency = resourceCommandProfile("node", ["scripts/run-checks.mjs"], { environment: { MBM_CHECK_CONCURRENCY: "" } });
assert.equal(isElasticCompilerRequest(emptyVerificationConcurrency), emptyVerificationConcurrency.compiler_jobs > 1,
  "empty MBM_CHECK_CONCURRENCY stopped matching run-checks' implicit/default semantics");
assert.equal(applyResourceProfileEnv({ MBM_CHECK_CONCURRENCY: "" }, emptyVerificationConcurrency).MBM_CHECK_CONCURRENCY,
  String(emptyVerificationConcurrency.compiler_jobs), "empty verification concurrency was not replaced by the admission-selected implicit fan-out");
for (const invalid of ["invalid", "17", "0", " "]) {
  const invalidPlan = resourceCommandProfile("node", ["scripts/run-checks.mjs"], { environment: { MBM_CHECK_CONCURRENCY: invalid } });
  assert.equal(invalidPlan.unbounded, true, `invalid MBM_CHECK_CONCURRENCY ${JSON.stringify(invalid)} was silently charged as the default fan-out`);
  assert.equal(invalidPlan.compiler_jobs, null, "invalid verification concurrency published a fictitious bounded worker count");
  assert.equal(applyResourceProfileEnv({ MBM_CHECK_CONCURRENCY: invalid }, invalidPlan).MBM_CHECK_CONCURRENCY, invalid,
    "resource environment normalization overwrote a nonempty invalid verification concurrency that run-checks must reject");
}
assert.equal(resourceCommandProfile("node", ["scripts/latest.mjs"]).resource_class, "adaptive", "substring 'test' inside latest caused false heavy classification");
assert.equal(resourceCommandProfile("node", ["scripts/contest.mjs"]).resource_class, "adaptive", "substring 'test' inside contest caused false heavy classification");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "env node scripts/coverage-check.mjs"]).family, "script-heavy", "shell-wrapped Node orchestration script was under-accounted");
assert.equal(resourceCommandProfile("/usr/bin/python3", ["-u", "verify-ios-example.py"]).family, "script-heavy", "direct Python orchestration script with interpreter options was under-accounted");
assert.equal(resourceCommandProfile("/usr/bin/python3", ["-m", "coverage", "/tmp/release-notes.py"]).resource_class, "adaptive", "Python module mode treated an ordinary later argument as an executed script");
assert.equal(resourceCommandProfile("npm", ["run", "check"]).family, "verification-plan", "npm check orchestration script was under-accounted");
assert.equal(resourceCommandProfile("npm", ["test"]).family, "js-build", "ordinary npm test stopped using the bounded js-build profile");
const runtimeReleaseCanaryEntry = join(repositoryRoot, "scripts", "release-oauth-canary.mjs");
const directReleaseCanaryArgs = [runtimeReleaseCanaryEntry, "--allow-live-oauth-canary"];
const releaseCanary = resourceCommandProfile("node", directReleaseCanaryArgs, releaseControlOptions);
assert.equal(releaseCanary.heavy, false, "direct activated-runtime OAuth canary was charged as a local build workload");
assert.equal(releaseCanary.family, "release-control", "direct activated-runtime OAuth canary lost its explicit release-control profile");
assert.equal(resourceCommandProfile("npm", ["run", "release:oauth-canary", "--", "--allow-live-oauth-canary"], releaseControlOptions).family, "js-build",
  "npm lifecycle invocation regained the release-control exception despite configurable script-shell execution");
for (const [command, args, label] of [
  ["node", [runtimeReleaseCanaryEntry], "missing live-canary flag"],
  ["node", [...directReleaseCanaryArgs, "extra"], "extra argv"],
  ["node", ["scripts/release-oauth-canary.mjs", "--allow-live-oauth-canary"], "workspace-relative entrypoint"],
  ["node", [join(repositoryRoot, "scripts", "release-oauth-canary-extra.mjs"), "--allow-live-oauth-canary"], "lookalike entrypoint"],
  ["npm", ["run", "release:oauth-canary"], "npm lifecycle"],
  ["pnpm", ["run", "release:oauth-canary"], "alternate package manager"],
]) {
  assert.notEqual(resourceCommandProfile(command, args, releaseControlOptions).family, "release-control",
    `${label} acquired release-control identity`);
}
assert.notEqual(resourceCommandProfile("/bin/zsh", ["-f", "-c", "node scripts/release-oauth-canary.mjs --allow-live-oauth-canary"], releaseControlOptions).family, "release-control",
  "release-control exception broadened from direct Node argv into an arbitrary shell");
assert.equal(resourceCommandProfile("", [], releaseControlOptions).family, "generic-process",
  "empty command acquired release-control identity through default-token handling");
const releaseExecutableRoot = mkdtempSync(join(tmpdir(), "mbm-release-control-exec-"));
try {
  const trustedDir = join(releaseExecutableRoot, "trusted");
  const shadowDir = join(releaseExecutableRoot, "shadow");
  const workDir = join(releaseExecutableRoot, "work");
  mkdirSync(trustedDir); mkdirSync(shadowDir); mkdirSync(workDir);
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const trustedNode = join(trustedDir, executableName);
  const shadowNode = join(shadowDir, executableName);
  for (const filePath of [trustedNode, shadowNode]) writeFileSync(filePath, "synthetic node executable\n", { mode: 0o755 });
  const trustedEnvironment = { PATH: trustedDir };
  const shadowedEnvironment = { PATH: [shadowDir, trustedDir].join(delimiter) };
  assert.equal(await releaseControlExecutableIsTrusted("node", trustedEnvironment, { cwd: workDir, runtimeExecutable: trustedNode }), true,
    "trusted first PATH Node executable did not authorize release-control accounting");
  assert.equal(await releaseControlExecutableIsTrusted("node", shadowedEnvironment, { cwd: workDir, runtimeExecutable: trustedNode }), false,
    "shadowing first PATH Node was skipped in favor of the runtime executable");
  assert.equal(await releaseControlExecutableIsTrusted(trustedNode, trustedEnvironment, { cwd: workDir, runtimeExecutable: trustedNode }), true,
    "trusted absolute runtime Node executable lost release-control eligibility");
  assert.equal(await releaseControlExecutableIsTrusted("node", { PATH: "../trusted" }, { cwd: workDir, runtimeExecutable: trustedNode }), true,
    "relative PATH entry was not resolved from the child cwd");
  assert.equal(await releaseControlExecutableIsTrusted("node", { PATH: join(releaseExecutableRoot, "missing") }, { cwd: workDir, runtimeExecutable: trustedNode }), false,
    "missing Node executable received release-control eligibility");
  assert.equal(await releaseControlExecutableIsTrusted("", trustedEnvironment, { cwd: workDir, runtimeExecutable: trustedNode }), false,
    "empty executable received release-control eligibility");
  for (const key of ["NODE_OPTIONS", "NODE_DEBUG", "NODE_PRESERVE_SYMLINKS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "UV_THREADPOOL_SIZE", "NODE_V8_COVERAGE", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
    assert.equal(await releaseControlExecutableIsTrusted("node", { PATH: trustedDir, [key]: "synthetic" }, { cwd: workDir, runtimeExecutable: trustedNode }), false,
      `${key} startup injection retained zero-resource release-control eligibility`);
  }

  const winFiles = new Map([
    ["c:\\runtime\\node.exe", "C:\\runtime\\node.exe"],
    ["c:\\shadow\\node.exe", "C:\\shadow\\node.exe"],
  ]);
  const winOptions = {
    cwd: "C:\\work",
    platform: "win32",
    runtimeExecutable: "C:\\runtime\\node.exe",
    realpath: async (candidate) => {
      const canonical = winFiles.get(String(candidate).toLowerCase());
      if (!canonical) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return canonical;
    },
    stat: async () => ({ isFile: () => true }),
  };
  assert.equal(await releaseControlExecutableIsTrusted("node", { Path: "C:\\runtime", PATHEXT: ".EXE;.CMD" }, winOptions), true,
    "Windows PATH/PATHEXT resolution did not match the runtime Node executable");
  assert.equal(await releaseControlExecutableIsTrusted("node", { Path: "C:\\shadow;C:\\runtime", PATHEXT: ".EXE;.CMD" }, winOptions), false,
    "Windows resolver skipped a shadowing first Node executable");

  const cleanRuntimeEnvironment = { PATH: process.env.PATH || "" };
  assert.equal(await releaseControlWorkspaceForCommand(process.execPath, directReleaseCanaryArgs, repositoryRoot, cleanRuntimeEnvironment), true,
    "exact activated-runtime canary path plus current workspace/runtime identity did not authorize the direct canary exception");
  assert.equal(await releaseControlWorkspaceForCommand(process.execPath, ["scripts/release-oauth-canary.mjs", "--allow-live-oauth-canary"], repositoryRoot, cleanRuntimeEnvironment), false,
    "workspace-relative canary entrypoint regained the release-control exception instead of requiring activated-runtime code");
  assert.equal(await releaseControlWorkspaceForCommand("npm", ["run", "release:oauth-canary"], repositoryRoot, cleanRuntimeEnvironment), false,
    "npm lifecycle invocation received the direct-Node release-control exception");
  assert.equal(await releaseControlWorkspaceForCommand("echo", undefined, repositoryRoot, cleanRuntimeEnvironment), false,
    "default release workspace command args were not fail-closed");
  assert.equal(await releaseControlWorkspaceForCommand("/bin/zsh", ["-f", "-c", "node scripts/release-oauth-canary.mjs --allow-live-oauth-canary"], repositoryRoot, cleanRuntimeEnvironment), false,
    "shell-wrapped canary triggered the direct-Node release workspace exception");
} finally { rmSync(releaseExecutableRoot, { recursive: true, force: true }); }
assert.equal(await releaseControlWorkspaceMatches(join(tmpdir(), "mbm-release-control-missing")), false,
  "missing package metadata authorized a release-control workspace");
const collisionRoot = mkdtempSync(join(tmpdir(), "mbm-release-control-collision-"));
try {
  mkdirSync(join(collisionRoot, "scripts"));
  const exactManifest = { name: packageName, version: packageVersion };
  const writeManifest = (value) => writeFileSync(join(collisionRoot, "package.json"), typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(await releaseControlWorkspaceMatches(""), false, "empty cwd authorized a release-control workspace");
  assert.equal(await releaseControlWorkspaceMatches(null), false, "non-string cwd authorized a release-control workspace");
  writeManifest("{");
  assert.equal(await releaseControlWorkspaceMatches(collisionRoot), false, "invalid package JSON authorized a release-control workspace");
  for (const manifest of [
    { ...exactManifest, name: `${packageName}-collision` },
    { ...exactManifest, version: `${packageVersion}.collision` },
  ]) {
    writeManifest(manifest);
    assert.equal(await releaseControlWorkspaceMatches(collisionRoot), false, "non-canonical release package identity authorized a release-control workspace");
  }
  writeManifest(exactManifest);
  const collisionCanary = join(collisionRoot, "scripts", "release-oauth-canary.mjs");
  writeFileSync(collisionCanary, "console.log('different project');\n");
  assert.equal(await releaseControlWorkspaceMatches(collisionRoot), false, "different canary entrypoint authorized a release-control workspace");
  assert.notEqual(resourceCommandProfile("node", directReleaseCanaryArgs, { releaseControlWorkspace: await releaseControlWorkspaceMatches(collisionRoot) }).family, "release-control",
    "same-name package with different canary bytes received the Machine Bridge release-control exception");
  writeFileSync(collisionCanary, readFileSync(runtimeReleaseCanaryEntry, "utf8"));
  assert.equal(await releaseControlWorkspaceMatches(collisionRoot), true,
    "same-name/version workspace with exact canary bytes did not satisfy the workspace data check");
  assert.equal(await releaseControlWorkspaceForCommand(process.execPath, [collisionCanary, "--allow-live-oauth-canary"], collisionRoot, { PATH: process.env.PATH || "" }), false,
    "non-runtime canary path received release-control eligibility");
} finally { rmSync(collisionRoot, { recursive: true, force: true }); }
assert.equal(resourceCommandProfile("npm", ["exec", "echo", "test"]).resource_class, "adaptive", "ordinary npm argument triggered lifecycle classification");
assert.equal(resourceCommandProfile("npm", ["run", "lint", "--", "test"]).resource_class, "adaptive", "ordinary npm script argument triggered lifecycle classification");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "npm run check"]).family, "verification-plan", "shell-wrapped npm check orchestration script was under-accounted");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "CI=1 env npm run check"]).family, "verification-plan", "env-wrapped npm check orchestration script was under-accounted");
assert.equal(resourceCommandProfile("sh", ["scripts/info.sh", "/tmp/release-notes.md"]).resource_class, "adaptive", "ordinary argument after a harmless shell script triggered heavy classification");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "echo cargo test"]).resource_class, "adaptive",
  "quoted heavy-looking words inside an arbitrary shell payload should stay adaptive, not become zero-resource or heavy build work");
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "cd /tmp && cargo test"]).family, "cargo");
assert.equal(resourceCommandProfile("xcodebuild", ["-version"]).heavy, false);
assert.equal(resourceCommandProfile("/bin/zsh", ["-c", "shasum -a 256 tests/resource-admission-test.mjs"]).resource_class, "adaptive", "test filename in an ordinary argument was misclassified as a heavy shell script");
assert.equal(resourceCommandProfile("bash", ["-x", "scripts/release_gate.sh"]).family, "script-heavy", "direct shell script with interpreter options was not classified as heavy");
const scopedScriptArgs = ["-c", "cd /tmp/project-a && ./scripts/release_gate.sh"];
const scopedScript = resourceCommandProfile("/bin/zsh", scopedScriptArgs);
assert.equal(resourceCommandEffectiveCwd("/bin/zsh", scopedScriptArgs, "/tmp/shared", scopedScript), resolve("/tmp/project-a"), "literal shell cwd did not narrow project contention scope");
const uncertainScriptArgs = ["-c", "cd $PROJECT && ./scripts/release_gate.sh"];
assert.equal(resourceCommandEffectiveCwd("/bin/zsh", uncertainScriptArgs, "/tmp/shared", scopedScript), resolve("/tmp/shared"), "dynamic shell cwd was trusted for contention scope");

const fittedCargo = fitElasticRequestToPressure(cargo, {
  state: "green", used: { cpu: 0 }, requested: { cpu: 3 }, limits: { cpu: 6.5, cpu_overcommit: 1.35 },
  observed: { cpu_busy_cores: 4.7, unobserved_reserved_cpu: 0 },
});
assert.equal(fittedCargo.cpu, 2, "implicit Cargo CPU request did not shrink to current host headroom");
assert.equal(fittedCargo.compiler_jobs, 2, "implicit Cargo worker cap did not shrink with CPU request");
assert.equal(fittedCargo.memory_mb, cargo.memory_mb, "Cargo memory reservation was scaled without a declared elastic memory model");
const reservationFittedCargo = fitElasticRequestToPressure(cargo, {
  state: "green", used: { cpu: 7 }, requested: { cpu: 3 }, limits: { cpu: 6.5, cpu_overcommit: 1.35 },
  observed: { cpu_busy_cores: 1, unobserved_reserved_cpu: 0 },
});
assert.equal(reservationFittedCargo.compiler_jobs, 1, "implicit fan-out did not shrink to durable CPU reservation headroom");
const parentCoveredCargo = fitElasticRequestToPressure(cargo, {
  state: "green", used: { cpu: 7 }, requested: { cpu: 0 }, limits: { cpu: 6.5, cpu_overcommit: 1.35 },
  observed: { cpu_busy_cores: 6.4, unobserved_reserved_cpu: 0 },
});
assert.strictEqual(parentCoveredCargo, cargo, "parent envelope coverage caused elastic fan-out to shrink a zero-increment nested request");
const memoryElasticVerification = markElasticCompilerJobs({ ...implicitVerificationPlan, cpu: 4, compiler_jobs: 4, memory_mb: 4096 }, true, 2048);
const memoryFittedVerification = fitElasticRequestToPressure(memoryElasticVerification, {
  state: "green", used: { cpu: 0, memory_mb: 7500 }, requested: { cpu: 4, memory_mb: 4096 },
  limits: { cpu: 6.5, cpu_overcommit: 1.35, memory_mb: 10000, memory_overcommit: 1 },
  observed: { cpu_busy_cores: 1, unobserved_reserved_cpu: 0 },
});
assert.equal(memoryFittedVerification.compiler_jobs, 2, "verification fan-out did not shrink to durable memory reservation headroom");
assert.equal(memoryFittedVerification.memory_mb, 2048, "verification memory reservation did not track memory-driven fan-out fitting");
assert.equal(memoryFittedVerification.cpu, 2, "memory-driven fan-out fitting left a stale larger CPU reservation");
assert.strictEqual(fitElasticRequestToPressure(cargo, null), cargo, "missing pressure mutated the elastic request");
assert.strictEqual(fitElasticRequestToPressure(cargo, {
  state: "red", limits: { cpu: 2 }, observed: { cpu_busy_cores: 2, unobserved_reserved_cpu: 0 },
}), cargo, "red pressure rewrote fan-out even though normal admission must still reject it");
assert.strictEqual(fitElasticRequestToPressure(cargo, {
  state: "green", used: { cpu: 0 }, requested: { cpu: 3 }, limits: { cpu: 6.5, cpu_overcommit: 1.35 },
  observed: { cpu_busy_cores: 1, unobserved_reserved_cpu: 0 },
}), cargo, "elastic fitting shrank a request that already fit host headroom");
assert.strictEqual(fitElasticRequestToPressure(explicitCargoJobs, {
  state: "green", used: { cpu: 7 }, requested: { cpu: 8 }, limits: { cpu: 6.5, cpu_overcommit: 1.35 },
  observed: { cpu_busy_cores: 6.4, unobserved_reserved_cpu: 0 },
}), explicitCargoJobs, "explicit Cargo request was rewritten by elastic fitting");

const linuxSample = sampleResourceHost({
  platform: "linux", cpuCores: 8,
  readFile: (file) => ({
    "/proc/meminfo": "MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n",
    "/proc/pressure/cpu": "some avg10=12.50 avg60=8.00 avg300=4.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "/proc/pressure/memory": "some avg10=2.50 avg60=1.00 avg300=0.50 total=1\nfull avg10=0.50 avg60=0.20 avg300=0.10 total=1\n",
    "/proc/pressure/io": "some avg10=3.50 avg60=2.00 avg300=1.00 total=1\nfull avg10=1.25 avg60=0.50 avg300=0.25 total=1\n",
  }[file] || ""),
});
assert.equal(linuxSample.memory_free_percent, 50);
assert.equal(linuxSample.psi_cpu_some_avg10, 12.5);
assert.equal(linuxSample.psi_memory_full_avg10, 0.5);
assert.equal(linuxSample.psi_io_full_avg10, 1.25);
assert.equal(linuxSample.io_sampled, true);
const linuxWithoutPsi = sampleResourceHost({ platform: "linux", cpuCores: 8, readFile: () => "" });
assert.equal(linuxWithoutPsi.io_sampled, false, "missing Linux PSI was reported as sampled I/O pressure");
const directLinuxHost = {};
sampleLinuxHost(directLinuxHost);
assert.equal(typeof directLinuxHost.io_sampled, "boolean", "default Linux reader did not normalize PSI sampling state");
if (process.platform !== "linux") {
  assert.equal(directLinuxHost.io_sampled, false, "default Linux reader treated unavailable /proc PSI as sampled");
}
const defaultSyncHost = sampleResourceHost({ platform: "linux", cpuCores: 8, readFile: () => "" });
assert.equal(defaultSyncHost.io_sampled, false);
const defaultAsyncHost = await sampleResourceHostAsync({ platform: "linux", cpuCores: 8, readFile: () => "" });
assert.equal(defaultAsyncHost.io_sampled, false);
const syntheticWindowsHost = sampleResourceHost({ platform: "win32", cpuCores: 8 });
assert(Number.isFinite(syntheticWindowsHost.memory_free_percent)
  && syntheticWindowsHost.memory_free_percent >= 0 && syntheticWindowsHost.memory_free_percent <= 100,
"Windows host sampling left memory pressure unknown despite Node exposing physical-memory availability");
assert(Number.isFinite(syntheticWindowsHost.cpu_time_ms_total) && Number.isFinite(syntheticWindowsHost.cpu_idle_ms_total),
  "Windows host sampling omitted cumulative CPU evidence");
const windowsCpuRates = deriveHostRates({
  sampled_at_ms: 2_000, cpu_cores: 8, cpu_busy_cores: null,
  cpu_time_ms_total: 16_000, cpu_idle_ms_total: 8_000,
}, {
  sampled_at_ms: 1_000, cpu_cores: 8, cpu_busy_cores: null,
  cpu_time_ms_total: 8_000, cpu_idle_ms_total: 6_000,
});
assert.equal(windowsCpuRates.cpu_busy_cores, 6,
  "cumulative Windows CPU evidence did not derive busy-core pressure from the previous host sample");
const directDarwin = {};
sampleDarwinHost(directDarwin, {
  quick: false,
  runCommand: (command) => {
    if (command.endsWith("memory_pressure")) return { ok: true, stdout: "System-wide memory free percentage: 42%\n" };
    if (command.endsWith("vm_stat")) return { ok: true, stdout: "Pageouts: 123.\nSwapouts: 45.\n" };
    if (command.endsWith("iostat")) return { ok: true, stdout: "          disk0\n    KB/t xfrs MB\n    1.0 700 42\n" };
    return { ok: true, stdout: "No thermal warning level has been recorded\nNo performance warning level has been recorded\n" };
  },
});
assert.equal(directDarwin.memory_free_percent, 42);
assert.equal(directDarwin.pageouts_total, 123);
assert.equal(directDarwin.swapouts_total, 45);
assert.equal(directDarwin.disk_iops, 700);
assert.equal(directDarwin.disk_mb_per_s, 42);
assert.equal(directDarwin.io_sampled, true);
assert.equal(directDarwin.thermal_warning, false);
const failedDarwinIo = {};
sampleDarwinHost(failedDarwinIo, {
  quick: false,
  runCommand: (command) => command.endsWith("iostat")
    ? { ok: false, stdout: "" }
    : { ok: true, stdout: "" },
});
assert.equal(failedDarwinIo.io_sampled, undefined, "failed Darwin iostat probe was cached as successful I/O evidence");
assert.equal(failedDarwinIo.io_sampled_at_ms, undefined, "failed Darwin iostat probe received a reusable evidence timestamp");
const malformedDarwinIo = {};
sampleDarwinHost(malformedDarwinIo, {
  quick: false,
  runCommand: (command) => command.endsWith("iostat")
    ? { ok: true, stdout: "iostat produced no numeric sample\n" }
    : { ok: true, stdout: "" },
});
assert.equal(malformedDarwinIo.io_sampled, undefined, "unparseable Darwin iostat output was cached as successful I/O evidence");
sampleDarwinHost({}, { quick: true });
await sampleDarwinHostAsync({ quick: true });

const hierarchyNow = Date.now();
const hierarchyKey = "1".repeat(32);
const parentEnvelope = { ...scriptHeavy, contention_key: hierarchyKey };
const parentLease = resourceLease("a".repeat(32), 100, parentEnvelope, hierarchyNow - 60_000);
const equalChild = resourceLease("b".repeat(32), 200, { ...parentEnvelope }, hierarchyNow - 60_000);
const largerChild = resourceLease("c".repeat(32), 200, { ...parentEnvelope, cpu: 3 }, hierarchyNow);
const siblingChild = resourceLease("d".repeat(32), 300, { ...parentEnvelope, cpu: 2 }, hierarchyNow - 60_000);
const processParents = parseResourceProcessParents("100 1\n150 100\n200 100\n300 100\n400 100\n");
assert(processParents, "process parent snapshot did not parse");
assert.deepEqual(sampleResourceProcessParents({ run: () => ({ ok: true, stdout: "100 1\n200 100\n" }) }), { "100": 1, "200": 100 });
if (process.platform !== "win32") assert(sampleResourceProcessParents(), "default bounded process-parent probe returned no process graph");
let ancestryClock = 10_000;
let ancestrySamples = 0;
const cachedParents = cachedResourceProcessParentSampler(
  () => { ancestrySamples += 1; return processParents; }, () => ancestryClock, 1_000,
);
assert.equal(cachedParents(), processParents);
ancestryClock += 999;
assert.equal(cachedParents(), processParents);
assert.equal(ancestrySamples, 1, "ancestry cache repeated a system-wide process scan inside its freshness window");
ancestryClock += 2;
assert.equal(cachedParents(), processParents);
assert.equal(ancestrySamples, 2, "ancestry cache failed to refresh after its bounded freshness window");
let failedAncestrySamples = 0;
const cachedMissingParents = cachedResourceProcessParentSampler(
  () => { failedAncestrySamples += 1; ancestryClock += 3_000; return null; }, () => ancestryClock, 1_000,
);
assert.equal(cachedMissingParents(), null);
ancestryClock += 500;
assert.equal(cachedMissingParents(), null);
assert.equal(failedAncestrySamples, 1, "failed ancestry sampling was retried inside the cache window");
let asyncAncestryClock = 20_000;
let asyncAncestrySamples = 0;
let finishAsyncAncestry;
const asyncAncestryGate = new Promise((resolvePromise) => { finishAsyncAncestry = resolvePromise; });
const cachedParentsAsync = cachedResourceProcessParentSamplerAsync(
  async () => { asyncAncestrySamples += 1; await asyncAncestryGate; return processParents; },
  () => asyncAncestryClock,
  1_000,
);
const asyncParentsA = cachedParentsAsync();
const asyncParentsB = cachedParentsAsync();
await Promise.resolve();
assert.equal(asyncAncestrySamples, 1, "concurrent ancestry requests did not share one in-flight system scan");
finishAsyncAncestry();
assert.equal(await asyncParentsA, processParents);
assert.equal(await asyncParentsB, processParents);
asyncAncestryClock += 999;
assert.equal(await cachedParentsAsync(), processParents);
assert.equal(asyncAncestrySamples, 1, "async ancestry cache repeated a system-wide scan inside its freshness window");
let releaseHostProbes;
const hostProbeGate = new Promise((resolvePromise) => { releaseHostProbes = resolvePromise; });
const hostProbeCalls = [];
const asyncHostSample = sampleResourceHostAsync({
  platform: "darwin", cpuCores: 8, cwd: process.cwd(), quick: false,
  runCommandAsync: async (command, args) => {
    hostProbeCalls.push([command, ...args]);
    await hostProbeGate;
    return { ok: false, stdout: "" };
  },
});
await Promise.resolve();
assert.equal(hostProbeCalls.length, 4, "Darwin host probes were serialized instead of launched concurrently");
let eventLoopResponsive = false;
await new Promise((resolvePromise) => { setTimeout(() => { eventLoopResponsive = true; resolvePromise(); }, 5); });
assert.equal(eventLoopResponsive, true, "async host sampling blocked the Node event loop");
releaseHostProbes();
await asyncHostSample;
const cacheScope = "resource-host-cache-test";
const cachedHost = { ...green, sample_scope: cacheScope, sampled_at_ms: 1_000, cpu_busy_cores: 7 };
let quickRefreshes = 0;
const reusedHost = await freshResourceHostSnapshot({
  cached: cachedHost, current: 1_400, cwd: "/tmp", request: { resource_class: "adaptive" }, scope: cacheScope,
  sampleHost: async () => { quickRefreshes += 1; return { ...green, sampled_at_ms: 1_400, cpu_busy_cores: 1 }; },
});
assert.strictEqual(reusedHost, cachedHost, "sub-500ms quick host evidence was needlessly resampled");
assert.equal(quickRefreshes, 0);
const refreshedHost = await freshResourceHostSnapshot({
  cached: cachedHost, current: 1_600, cwd: "/tmp", request: { resource_class: "adaptive" }, scope: cacheScope,
  sampleHost: async (options) => { quickRefreshes += 1; assert.strictEqual(options.previous, cachedHost); assert.equal(options.quick, true); return { ...green, sampled_at_ms: 1_600, cpu_busy_cores: 1 }; },
});
assert.equal(quickRefreshes, 1, "stale quick CPU evidence survived beyond the 500ms recovery window");
assert.equal(refreshedHost.cpu_busy_cores, 1, "stale CPU pressure was returned after the quick-host freshness window");
let crossScopeOptions = null;
const crossScopeCached = { ...cachedHost, io_sampled: true, io_sampled_at_ms: 1_000, disk_mb_per_s: 999, disk_iops: 9999 };
const crossScopeHost = await freshResourceHostSnapshot({
  cached: crossScopeCached, current: 1_700, cwd: "/other", request: { resource_class: "io" }, scope: "other-resource-scope",
  sampleHost: async (options) => { crossScopeOptions = options; return { ...green, sampled_at_ms: 1_700, disk_mb_per_s: 3, disk_iops: 30, io_sampled: true }; },
});
assert.strictEqual(crossScopeOptions.previous, crossScopeCached, "recent global CPU anchor was not reused across project scopes");
assert.equal(crossScopeOptions.previous.sample_scope, cacheScope, "cross-scope CPU anchor lost its source generation");
assert.equal(crossScopeOptions.quick, false, "scope-local I/O evidence leaked across projects and suppressed a fresh I/O probe");
assert.equal(crossScopeHost.disk_mb_per_s, 3, "cross-scope refresh reused another project's cached I/O throughput");
let staleCpuPrevious = "unset";
await freshResourceHostSnapshot({
  cached: cachedHost, current: 3_001, cwd: "/tmp", request: { resource_class: "adaptive" }, scope: cacheScope,
  sampleHost: async (options) => { staleCpuPrevious = options.previous; return { ...green, sampled_at_ms: 3_001, cpu_busy_cores: 2 }; },
});
assert.equal(staleCpuPrevious, null, "CPU refresh reused a cumulative anchor older than the 2s current-pressure window");
let cpuSnapshot = 0;
const syntheticCpu = await sampleResourceHostAsync({
  platform: "win32", cpuCores: 8, cpuSampleSleep: async () => {},
  cpuTimes: () => cpuSnapshot++ === 0
    ? [{ times: { user: 100, nice: 0, sys: 100, idle: 600, irq: 0 } }]
    : [{ times: { user: 200, nice: 0, sys: 200, idle: 800, irq: 0 } }],
});
assert.equal(syntheticCpu.cpu_busy_cores, 4, "short-window CPU-time sampling did not derive current busy-core pressure");
let warmCpuSleep = 0;
const warmCpu = await sampleResourceHostAsync({
  platform: "win32", cpuCores: 8, previous: { cpu_time_ms_total: 800, cpu_idle_ms_total: 600 },
  cpuSampleSleep: async () => { warmCpuSleep += 1; },
  cpuTimes: () => [{ times: { user: 200, nice: 0, sys: 200, idle: 800, irq: 0 } }],
});
assert.equal(warmCpu.cpu_busy_cores, 4, "cached cumulative CPU window did not derive current busy-core pressure");
assert.equal(warmCpuSleep, 0, "warm host sampling retained the avoidable 50ms CPU probe delay");
const parentContext = resourceLeaseAccountingContext([parentLease], processParents, 150);
assert.equal(parentContext.parentLeaseId, parentLease.lease_id);
assert.deepEqual(parentContext.ancestorLeaseIds, [parentLease.lease_id]);
assert.equal(resourceRequestIncrement([parentLease], parentEnvelope, parentContext).cpu, 0, "covered nested request was double-counted");
const parentCoveredSnapshot = resourcePressureSnapshot({ ...green, cpu_busy_cores: 6.4, load1: 0 }, [parentLease], "ordinary", hierarchyNow, parentContext, parentEnvelope);
assert.equal(parentCoveredSnapshot.requested.cpu, 0, "internal pressure snapshot lost nested incremental CPU accounting");
assert.equal("requested" in resourcePressureSnapshot(green, [parentLease], "ordinary", hierarchyNow, parentContext), false,
  "ordinary diagnostics exposed request-specific incremental accounting without an internal request");
assert.equal(resourceRequestIncrement([parentLease], { ...parentEnvelope, cpu: 3 }, parentContext).cpu, 0.5, "larger nested request did not reserve only its delta");
const equalHierarchy = resourceLeaseAccountingContext([parentLease, equalChild], processParents, 400);
assert.equal(aggregateResourceLeases([parentLease, equalChild], equalHierarchy).cpu, 2.5, "equal child duplicated parent envelope");
const siblingHierarchy = resourceLeaseAccountingContext([parentLease, equalChild, siblingChild], processParents, 400);
assert.equal(aggregateResourceLeases([parentLease, { ...equalChild, request: { ...equalChild.request, cpu: 2 } }, siblingChild], siblingHierarchy).cpu, 4, "parallel children did not sum beneath parent envelope");
const largerHierarchy = resourceLeaseAccountingContext([parentLease, largerChild], processParents, 400);
const largerUsed = aggregateResourceLeases([parentLease, largerChild], largerHierarchy);
assert.equal(largerUsed.cpu, 3);
assert.equal(unobservedResourceCpu([parentLease, largerChild], largerHierarchy, hierarchyNow - 1), 0.5,
  "post-sample nested child charged its full CPU instead of incremental unobserved pressure");
assert.equal(unobservedResourceCpu([parentLease, largerChild], largerHierarchy, hierarchyNow), 0,
  "lease already present in the CPU sample remained double-counted as unobserved pressure");
assert.equal(aggregateResourceLeases([largerChild], resourceLeaseAccountingContext([largerChild], processParents, 400)).cpu, 3, "child lost full reservation after parent removal");
assert.equal(aggregateResourceLeases([parentLease, largerChild], {}).cpu, 5.5, "missing ancestry did not fall back to conservative full summation");
const nestedSameProject = evaluateResourceAdmission({ ...green, cpu_busy_cores: 0, load1: 0 }, [parentLease], parentEnvelope, hierarchyNow, { accounting: parentContext });
assert.equal(nestedSameProject.admitted, true, "nested request self-blocked on ancestor project contention");
assert.equal(nestedSameProject.requested.cpu, 0);
const siblingContention = evaluateResourceAdmission(
  { ...green, cpu_busy_cores: 0, load1: 0 }, [parentLease, siblingChild], parentEnvelope, hierarchyNow,
  { accounting: resourceLeaseAccountingContext([parentLease, siblingChild], processParents, 400) },
);
assert.equal(siblingContention.reason, "project_resource_busy", "same-key sibling contention was incorrectly ignored");

const validRequest = { ...cargo, contention_key: null };
assert.equal(validateResourceRequest(validRequest), validRequest);
assert.throws(() => validateResourceRequest(null), /resource request is invalid/);
assert.throws(() => validateResourceRequest({ ...validRequest, cpu: Number.NaN }), /resource request cpu is invalid/);
assert.throws(() => validateResourceRequest({ ...validRequest, compiler_jobs: 0 }), /compiler jobs are invalid/);
assert.throws(() => validateResourceRequest({ ...validRequest, contention_key: "not-a-key" }), /contention key is invalid/);

let decision = evaluateResourceAdmission(green, [], cargo, Date.now());
assert.equal(decision.admitted, true);
assert.equal(decision.state, "green");
const greenLimits = decision.limits;
const red = { ...green, disk_mb_per_s: 230, disk_iops: 5100 };
decision = evaluateResourceAdmission(red, [], cargo, Date.now());
assert.equal(decision.admitted, false);
assert.equal(decision.state, "red");
const yellow = { ...green, disk_mb_per_s: 120 };
decision = evaluateResourceAdmission(yellow, [], cargo, Date.now());
assert.equal(decision.state, "yellow");
assert.equal(decision.admitted, true);
assert.equal(decision.limits.cpu, greenLimits.cpu, "I/O-only yellow pressure incorrectly reduced CPU capacity");
assert(decision.limits.io < greenLimits.io, "I/O-only yellow pressure did not tighten I/O capacity");
assert.equal(decision.limits.memory_mb, greenLimits.memory_mb, "I/O-only yellow pressure incorrectly reduced memory capacity");
const diskSoft = { ...green, disk_free_bytes: 67 * GIB };
const diskSoftDecision = evaluateResourceAdmission(diskSoft, [], cargo, Date.now());
assert.equal(diskSoftDecision.state, "yellow");
assert.equal(diskSoftDecision.admitted, true, "soft disk headroom incorrectly became a hard build reject");
assert(diskSoftDecision.pressure_reasons.includes("disk_free_headroom"));
assert.equal(diskSoftDecision.limits.cpu, greenLimits.cpu, "soft disk headroom incorrectly reduced CPU capacity");
assert(diskSoftDecision.limits.io < greenLimits.io, "soft disk headroom did not tighten write-heavy I/O capacity");
const diskLow = { ...green, disk_free_bytes: 49 * GIB };
assert.equal(evaluateResourceAdmission(diskLow, [], cargo, Date.now()).reason, "disk_reserve_floor");
const diskCritical = { ...green, disk_free_bytes: 45 * GIB };
assert.equal(evaluateResourceAdmission(diskCritical, [], cargo, Date.now()).reason, "host_pressure_red");
const reclaimDecision = evaluateResourceAdmission(diskCritical, [], diskReclaim, Date.now());
assert.equal(reclaimDecision.admitted, true, "disk-only critical pressure blocked a trusted direct reclaim operation");
assert.equal(reclaimDecision.reason, "admitted_disk_reclaim");
assert.deepEqual(reclaimDecision.pressure_reasons, ["disk_free_headroom_critical"]);
assert.equal(evaluateResourceAdmission(diskCritical, [], { ...diskReclaim, cpu: 1 }, Date.now()).reason, "host_pressure_red",
  "oversized request spoofed the disk-reclaim family to bypass critical pressure");
const unsafeReclaimPressure = evaluateResourceAdmission(
  { ...diskCritical, memory_free_percent: 7 }, [], diskReclaim, Date.now(),
);
assert.equal(unsafeReclaimPressure.admitted, false, "disk reclaim bypassed independent critical memory pressure");
assert.equal(unsafeReclaimPressure.reason, "host_pressure_red");
assert.equal(resourceDiskHardFloorBytes(64 * GIB), 6.4 * GIB, "small volumes inherited an impossible 50 GiB hard floor");
assert.equal(resourceDiskSoftFloorBytes(64 * GIB), 9.6 * GIB, "small volumes inherited an impossible 80 GiB soft floor");
assert.equal(evaluateResourceAdmission({ ...green, disk_total_bytes: 64 * GIB, disk_free_bytes: 12 * GIB }, [], cargo, Date.now()).state, "green",
  "healthy small-volume headroom was globally throttled by a large-volume absolute floor");
const previous = { sampled_at_ms: 1_000, pageouts_total: 100, swapouts_total: 20 };
const current = { sampled_at_ms: 3_000, pageouts_total: 300, swapouts_total: 60 };
assert.equal(deriveHostRates(current, previous).pageouts_per_s, 100);
assert.equal(deriveHostRates(current, previous).swapouts_per_s, 20);
const missingSignals = { ...green, memory_free_percent: null, pageouts_per_s: null, swapouts_per_s: null, disk_mb_per_s: null, disk_iops: null };
assert.equal(evaluateResourceAdmission(missingSignals, [], cargo, Date.now()).admitted, true, "missing optional host signals were treated as zero-pressure failure values");
const memoryYellow = evaluateResourceAdmission({ ...green, memory_free_percent: 17 }, [], cargo, Date.now());
assert.equal(memoryYellow.state, "yellow", "host memory warning did not tighten admission");
assert.equal(memoryYellow.limits.cpu, greenLimits.cpu, "memory-only yellow pressure incorrectly reduced CPU capacity");
assert(memoryYellow.limits.memory_mb < greenLimits.memory_mb, "memory-only yellow pressure did not tighten memory capacity");
assert.equal(memoryYellow.limits.io, greenLimits.io, "memory-only yellow pressure incorrectly reduced I/O capacity");
const cpuPsiYellow = evaluateResourceAdmission({ ...green, psi_cpu_some_avg10: 10.1 }, [], cargo, Date.now());
assert.equal(cpuPsiYellow.state, "yellow", "Linux CPU PSI did not tighten admission");
assert(cpuPsiYellow.limits.cpu < greenLimits.cpu, "CPU PSI did not reduce CPU admission capacity");
assert.equal(cpuPsiYellow.limits.io, greenLimits.io, "CPU-only yellow pressure incorrectly reduced I/O capacity");
assert.equal(cpuPsiYellow.limits.memory_mb, greenLimits.memory_mb, "CPU-only yellow pressure incorrectly reduced memory capacity");
const crowdedRoots = Array.from({ length: 17 }, (_, index) => ({
  lease_id: (index + 1).toString(16).padStart(32, "0"),
  request: { ...cargo, cpu: 0, io: 0, memory_mb: 0, disk_reserve_bytes: 0, contention_key: null },
}));
const crowdedDecision = evaluateResourceAdmission(green, crowdedRoots, cargo, Date.now());
assert.equal(crowdedDecision.state, "yellow", "heavy-root density did not remain visible as an advisory pressure signal");
assert(crowdedDecision.pressure_reasons.includes("heavy_root_count"));
assert.equal(crowdedDecision.limits.cpu, greenLimits.cpu, "root count without CPU pressure recreated a global CPU tax");
assert.equal(crowdedDecision.limits.io, greenLimits.io, "root count without I/O pressure recreated a global I/O tax");
assert.equal(crowdedDecision.limits.memory_mb, greenLimits.memory_mb, "root count without memory pressure recreated a global memory tax");
const psiMemoryRed = evaluateResourceAdmission({ ...green, psi_memory_full_avg10: 60.1 }, [], cargo, Date.now());
assert.equal(psiMemoryRed.state, "red");
assert.equal(psiMemoryRed.reason, "host_pressure_red");
const darwinThreadBacklog = evaluateResourceAdmission({
  ...green, platform: "darwin", sampled_at_ms: hierarchyNow + 1_000, cpu_busy_cores: 3.5, load1: 56,
}, [], cargo, hierarchyNow + 1_000);
assert.equal(darwinThreadBacklog.state, "green", "Darwin runnable-thread load average became CPU pressure without corroborating saturation");
assert.equal(darwinThreadBacklog.admitted, true, "Darwin runnable-thread backlog caused false heavy-work rejection");
const observedRecentLease = resourceLease("e".repeat(32), 500, { ...scriptHeavy, cpu: 3, contention_key: null }, hierarchyNow);
const observedRecentDecision = evaluateResourceAdmission({
  ...green, sampled_at_ms: hierarchyNow + 1_000, cpu_busy_cores: 3.5, load1: 0,
}, [observedRecentLease], { ...resourceCommandProfile("pytest", ["-q"]), contention_key: null }, hierarchyNow + 1_000);
assert.equal(observedRecentDecision.admitted, true, "CPU already represented by the host sample was charged again as startup pressure");
const unobservedRecentDecision = evaluateResourceAdmission({
  ...green, sampled_at_ms: hierarchyNow - 1, cpu_busy_cores: 3.5, load1: 0,
}, [observedRecentLease], { ...resourceCommandProfile("pytest", ["-q"]), contention_key: null }, hierarchyNow + 1_000);
assert.equal(unobservedRecentDecision.reason, "cpu_pressure_window", "post-sample CPU reservation was not protected from oversubscription");
const quietInteractiveHost = { ...green, platform: "darwin", cpu_busy_cores: 0, load1: 0 };
const explicitPytestEight = resourceCommandProfile("pytest", ["-n", "8", "-q"], { priority: "interactive" });
const explicitPytestSeven = resourceCommandProfile("pytest", ["-n", "7", "-q"], { priority: "interactive" });
assert.equal(
  evaluateResourceAdmission(quietInteractiveHost, [], explicitPytestEight, hierarchyNow + 1_000).reason,
  "cpu_request_exceeds_launch_window",
  "fixed CPU fan-out above the best-case launch window remained disguised as transient CPU pressure",
);
assert.equal(
  evaluateResourceAdmission(quietInteractiveHost, [], explicitPytestSeven, hierarchyNow + 1_000).admitted,
  true,
  "fixed CPU fan-out at the best-case interactive launch limit was rejected",
);

const fairnessNow = Date.now();
const backgroundWaiter = waiter("background", fairnessNow - 10_000, resourceCommandProfile("pytest", ["-q"], { priority: "background" }), "a");
const interactiveWaiter = waiter("interactive", fairnessNow, resourceCommandProfile("pytest", ["-q"], { priority: "interactive" }), "b");
assert.equal(selectedResourceWaiter([backgroundWaiter, interactiveWaiter], [], green, evaluateResourceAdmission, fairnessNow).waiter_id, "b");
const agedBackground = waiter("background", fairnessNow - 4 * 60_000, resourceCommandProfile("pytest", ["-q"], { priority: "background" }), "c");
assert.equal(resourceWaiterRank(agedBackground, fairnessNow), 0);
assert.equal(selectedResourceWaiter([interactiveWaiter, agedBackground], [], green, evaluateResourceAdmission, fairnessNow).waiter_id, "c", "aged background waiter never reached interactive fairness rank");
const oversized = waiter("interactive", fairnessNow - 1_000, { ...cargo, cpu: 20, unbounded: false }, "d");
assert.equal(selectedResourceWaiter([oversized, backgroundWaiter], [], green, evaluateResourceAdmission, fairnessNow).waiter_id, "a", "unadmittable waiter caused head-of-line blocking");
const quietHost = { ...green, cpu_busy_cores: 0, load1: 0 };
const blockingLease = [{
  acquired_at: new Date(fairnessNow - 60_000).toISOString(),
  bound_at: new Date(fairnessNow - 60_000).toISOString(),
  request: { ...cargo, cpu: 7, contention_key: null },
}];
const youngLarge = waiter("interactive", fairnessNow - 30_000, cargo, "young-large");
const fittingSmall = waiter("background", fairnessNow - 1_000, resourceCommandProfile("pytest", ["-q"], { priority: "background" }), "small");
assert.equal(selectedResourceWaiter([youngLarge, fittingSmall], blockingLease, quietHost, evaluateResourceAdmission, fairnessNow).waiter_id, "small", "young blocked waiter disabled work-conserving backfill");
const protectedLarge = waiter("interactive", fairnessNow - 121_000, cargo, "protected-large");
assert.equal(resourceWaiterProtected(protectedLarge, fairnessNow), true);
const protectedQueue = resourceWaiterQueueSnapshot([protectedLarge, fittingSmall], fairnessNow);
assert.equal(protectedQueue.protected, 1, "queue diagnostics lost protected-waiter count");
assert.equal(selectedResourceWaiter([protectedLarge, fittingSmall], blockingLease, quietHost, evaluateResourceAdmission, fairnessNow), null, "starved feasible waiter did not reserve a drain window");
const locallyBusyHost = { ...quietHost, cpu_busy_cores: 4.5 };
assert.equal(selectedResourceWaiter([protectedLarge, fittingSmall], blockingLease, locallyBusyHost, evaluateResourceAdmission, fairnessNow), null, "local CPU already visible in host metrics defeated starvation drain");
assert.equal(selectedResourceWaiter([protectedLarge, fittingSmall], [], quietHost, evaluateResourceAdmission, fairnessNow).waiter_id, "protected-large", "protected waiter was not selected after capacity drained");
const impossibleOld = waiter("interactive", fairnessNow - 10 * 60_000, { ...cargo, cpu: 20, unbounded: false }, "impossible-old");
assert.equal(selectedResourceWaiter([impossibleOld, fittingSmall], blockingLease, quietHost, evaluateResourceAdmission, fairnessNow).waiter_id, "small", "structurally impossible waiter incorrectly drained the queue");
const impossibleLaunchWindow = waiter("interactive", fairnessNow - 10 * 60_000, explicitPytestEight, "impossible-launch-window");
assert.equal(
  selectedResourceWaiter([impossibleLaunchWindow, fittingSmall], blockingLease, quietHost, evaluateResourceAdmission, fairnessNow).waiter_id,
  "small",
  "CPU request above the best-case launch window incorrectly reserved a protected drain",
);
const diskDrainHost = { ...quietHost, disk_free_bytes: 120 * GIB, disk_total_bytes: 500 * GIB };
const diskBlockingLease = [{
  acquired_at: new Date(fairnessNow - 60_000).toISOString(),
  bound_at: new Date(fairnessNow - 60_000).toISOString(),
  request: { ...cargo, cpu: 0, io: 0, memory_mb: 0, disk_reserve_bytes: 50 * GIB, contention_key: null },
}];
const protectedDisk = waiter("interactive", fairnessNow - 121_000, {
  ...cargo, cpu: 1, io: 0, memory_mb: 512, disk_reserve_bytes: 30 * GIB, contention_key: null,
}, "protected-disk");
const diskFittingSmall = waiter("background", fairnessNow - 1_000, {
  ...resourceCommandProfile("pytest", ["-q"], { priority: "background" }),
  cpu: 1, io: 0, memory_mb: 512, disk_reserve_bytes: 0, contention_key: null,
}, "disk-small");
assert.equal(
  evaluateResourceAdmission(diskDrainHost, diskBlockingLease, protectedDisk.request, fairnessNow).reason,
  "disk_reserve_floor",
  "disk fairness fixture did not isolate active lease reservations",
);
assert.equal(
  evaluateResourceAdmission(diskDrainHost, [], protectedDisk.request, fairnessNow).admitted,
  true,
  "disk fairness fixture was structurally impossible even after lease drain",
);
assert.equal(
  selectedResourceWaiter([protectedDisk, diskFittingSmall], diskBlockingLease, diskDrainHost, evaluateResourceAdmission, fairnessNow),
  null,
  "starved feasible disk waiter did not reserve a drain window",
);
assert.equal(
  selectedResourceWaiter([protectedDisk, diskFittingSmall], [], diskDrainHost, evaluateResourceAdmission, fairnessNow).waiter_id,
  "protected-disk",
  "protected disk waiter was not selected after reservations drained",
);
const impossibleDisk = waiter("interactive", fairnessNow - 10 * 60_000, {
  ...protectedDisk.request, disk_reserve_bytes: 80 * GIB,
}, "impossible-disk");
assert.equal(
  evaluateResourceAdmission(diskDrainHost, [], impossibleDisk.request, fairnessNow).reason,
  "disk_reserve_floor",
  "impossible disk fairness fixture unexpectedly fit an empty lease set",
);
assert.equal(
  selectedResourceWaiter([impossibleDisk, diskFittingSmall], diskBlockingLease, diskDrainHost, evaluateResourceAdmission, fairnessNow).waiter_id,
  "disk-small",
  "structurally impossible disk waiter incorrectly drained the queue",
);

const root = mkdtempSync(join(tmpdir(), "mbm-resource-admission-"));
const canonicalProject = join(root, "canonical-project");
const aliasProject = join(root, "canonical-project-alias");
mkdirSync(canonicalProject);
assert.equal(
  resourceProjectContentionKey("script-heavy", "/canonical/project"),
  "b909ed89937111511823eab85b4ab16b",
  "resource contention v1 golden vector drifted",
);
assert.equal(resourceProjectIdentityHash("/canonical/project"), "688d578830238351b4cd48a7", "resource project hash golden vector drifted");
assert.equal(
  resourceProjectContentionKey("script-heavy", "c:\\workspace\\agent-repo"),
  "99a119b397de845230471d172e739f2b",
  "Windows resource contention v1 golden vector drifted",
);
assert.equal(
  normalizeResourceProjectIdentity("C:/Workspace/Agent-Repo", "win32"),
  normalizeResourceProjectIdentity("c:\\workspace\\agent-repo", "win32"),
  "Windows project identity remained case/separator sensitive",
);
assert.equal(
  normalizeResourceProjectIdentity("\\\\?\\C:\\Workspace\\Agent-Repo", "win32"),
  "c:\\workspace\\agent-repo",
  "Windows extended-path prefix changed project identity",
);
assert.equal(
  normalizeResourceProjectIdentity("\\\\?\\UNC\\Server\\Share\\Repo", "win32"),
  "\\\\server\\share\\repo",
  "Windows extended UNC prefix changed project identity",
);
try {
  symlinkSync(canonicalProject, aliasProject, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    resourceRequestForProject(scriptHeavy, canonicalProject).contention_key,
    resourceRequestForProject(scriptHeavy, aliasProject).contention_key,
    "project contention key changed across a filesystem alias",
  );
  assert.equal(resourceProjectHash(canonicalProject), resourceProjectHash(aliasProject), "anonymous project hash changed across a filesystem alias");
} catch (error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
}
let now = Date.now();
const coordinator = new ResourceCoordinator({
  root,
  now: () => now,
  sampleHost: () => ({ ...green, sampled_at_ms: now }),
  sleep: async () => {},
  random: () => 0,
});
try {
  await coordinator.withLock(() => {
    const lockPath = join(root, "transaction.lock");
    assert.equal(lstatSync(lockPath).isDirectory(), true, "resource coordinator lock lost beta.60-compatible directory wire shape");
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.schema_version, 1, "resource coordinator transaction claim lost its schema-1 compatibility marker");
    assert.match(owner.token, /^[a-f0-9]{32}$/, "resource coordinator transaction claim lost its ownership token");
    assert.equal(owner.pid, process.pid, "resource coordinator transaction claim lost its process owner");
  });

  const legacyLock = join(root, "transaction.lock");
  mkdirSync(legacyLock, { mode: 0o700 });
  writeFileSync(join(legacyLock, "owner.json"), `${JSON.stringify({
    schema_version: 1,
    token: "a".repeat(32),
    pid: process.pid,
    started_at: new Date().toISOString(),
    process_started_at: new Date(currentProcessStartTimeMs()).toISOString(),
  })}\n`, { mode: 0o600 });
  let legacyWaits = 0;
  await withResourceTransactionLock(root, () => {
    const owner = JSON.parse(readFileSync(join(legacyLock, "owner.json"), "utf8"));
    assert.notEqual(owner.token, "a".repeat(32), "beta.61 entered while a beta.60 directory lock was still owned");
  }, {
    timeoutMs: 500,
    random: () => 0,
    sleep: async () => { legacyWaits += 1; rmSync(legacyLock, { recursive: true, force: true }); },
  });
  assert.equal(legacyWaits, 1, "beta.61 did not wait for a live beta.60 directory transaction lock");

  writeFileSync(legacyLock, `${JSON.stringify({
    pid: process.pid,
    token: "b".repeat(32),
    purpose: "resource-coordinator",
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
  })}\n`, { mode: 0o600 });
  let priorFileWaits = 0;
  await withResourceTransactionLock(root, () => {
    assert.equal(lstatSync(legacyLock).isDirectory(), true, "beta.61 did not migrate back to the rolling-compatible directory lock after a prior file lock cleared");
  }, {
    timeoutMs: 500,
    random: () => 0,
    sleep: async () => { priorFileWaits += 1; rmSync(legacyLock, { force: true }); },
  });
  assert.equal(priorFileWaits, 1, "beta.61 did not wait for a live prior owner-state file lock");

  mkdirSync(legacyLock, { mode: 0o700 });
  const oldDirectoryTime = new Date(Date.now() - 10_000);
  utimesSync(legacyLock, oldDirectoryTime, oldDirectoryTime);
  let orphanOwnerInjected = false;
  let orphanRaceWaits = 0;
  await withResourceTransactionLock(root, () => {
    assert.equal(orphanOwnerInjected, true, "stale incomplete-directory race fixture did not inject a completing beta.60 owner");
  }, {
    timeoutMs: 500,
    random: () => 0,
    beforeReclaim: async (observed) => {
      if (orphanOwnerInjected || observed.kind !== "directory" || observed.owner !== null) return;
      orphanOwnerInjected = true;
      writeFileSync(join(legacyLock, "owner.json"), `${JSON.stringify({
        schema_version: 1,
        token: "c".repeat(32),
        pid: process.pid,
        started_at: new Date().toISOString(),
        process_started_at: new Date(currentProcessStartTimeMs()).toISOString(),
      })}\n`, { mode: 0o600 });
    },
    sleep: async () => {
      orphanRaceWaits += 1;
      const completedOwner = JSON.parse(readFileSync(join(legacyLock, "owner.json"), "utf8"));
      assert.equal(completedOwner.token, "c".repeat(32), "orphan reclaim deleted a beta.60 owner that completed after inspection");
      rmSync(legacyLock, { recursive: true, force: true });
    },
  });
  assert.equal(orphanRaceWaits, 1, "resource transaction lock did not wait after an observed orphan completed before stale reclamation");
  assert.equal(readdirSync(root).filter((name) => name.startsWith("transaction.lock.stale.")).length, 0,
    "incomplete-owner reclamation moved a late-completing beta.60 lock out of the canonical mutex");

  mkdirSync(legacyLock, { mode: 0o700 });
  const deadOwnerStagingName = `.owner.json.99999999.${"1".repeat(16)}.tmp`;
  const deadOwnerStaging = join(legacyLock, deadOwnerStagingName);
  writeFileSync(deadOwnerStaging, "partial-owner-publication\n", { mode: 0o600 });
  utimesSync(deadOwnerStaging, oldDirectoryTime, oldDirectoryTime);
  utimesSync(legacyLock, oldDirectoryTime, oldDirectoryTime);
  let recoveredDeadOwnerStaging = false;
  await withResourceTransactionLock(root, () => {
    recoveredDeadOwnerStaging = true;
    assert.deepEqual(readdirSync(legacyLock), ["owner.json"],
      "dead owner-publication staging survived into the replacement transaction generation");
  }, { timeoutMs: 500, random: () => 0, sleep: async () => {} });
  assert.equal(recoveredDeadOwnerStaging, true,
    "dead owner-publication staging permanently blocked resource transaction recovery");

  mkdirSync(legacyLock, { mode: 0o700 });
  const liveOwnerStagingName = `.owner.json.${process.pid}.${"2".repeat(16)}.tmp`;
  const liveOwnerStaging = join(legacyLock, liveOwnerStagingName);
  writeFileSync(liveOwnerStaging, "in-progress-owner-publication\n", { mode: 0o600 });
  utimesSync(legacyLock, oldDirectoryTime, oldDirectoryTime);
  let liveOwnerWaits = 0;
  await withResourceTransactionLock(root, () => {}, {
    timeoutMs: 500,
    random: () => 0,
    sleep: async () => {
      liveOwnerWaits += 1;
      assert.equal(readFileSync(liveOwnerStaging, "utf8"), "in-progress-owner-publication\n",
        "resource transaction recovery deleted a live owner publisher staging file");
      rmSync(legacyLock, { recursive: true, force: true });
    },
  });
  assert.equal(liveOwnerWaits, 1, "resource transaction recovery did not wait for a live owner publisher");

  mkdirSync(legacyLock, { mode: 0o700 });
  writeFileSync(join(legacyLock, "unexpected.tmp"), "unexpected\n", { mode: 0o600 });
  utimesSync(legacyLock, oldDirectoryTime, oldDirectoryTime);
  await assert.rejects(() => withResourceTransactionLock(root, () => {}, {
    timeoutMs: 500, random: () => 0, sleep: async () => {},
  }), /unexpected owner-publication state/,
  "resource transaction recovery deleted an unrecognized ownerless lock-directory entry");
  rmSync(legacyLock, { recursive: true, force: true });

  mkdirSync(legacyLock, { mode: 0o700 });
  writeFileSync(join(legacyLock, "owner.json"), `${JSON.stringify({
    schema_version: 1, token: "d".repeat(32), pid: 99_999_999,
    started_at: new Date().toISOString(), process_started_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  let replacementInjected = false;
  await assert.rejects(() => withResourceTransactionLock(root, () => {}, {
    timeoutMs: 500,
    random: () => 0,
    sleep: async () => {},
    beforeReclaim: async (observed) => {
      if (observed.kind !== "directory" || observed.owner?.token !== "d".repeat(32)) return;
      writeFileSync(join(legacyLock, "owner.json"), `${JSON.stringify({
        schema_version: 1, token: "f".repeat(32), pid: 99_999_999,
        started_at: new Date().toISOString(), process_started_at: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
    },
    beforeRestore: ({ lockPath }) => {
      replacementInjected = true;
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
        schema_version: 1, token: "e".repeat(32), pid: process.pid,
        started_at: new Date().toISOString(), process_started_at: new Date(currentProcessStartTimeMs()).toISOString(),
      })}\n`, { mode: 0o600 });
    },
  }), /replaced before quarantine restore/,
  "resource transaction quarantine restore overwrote a replacement lock generation");
  assert.equal(replacementInjected, true, "resource transaction replacement-race fixture never reached quarantine restore");
  assert.equal(JSON.parse(readFileSync(join(legacyLock, "owner.json"), "utf8")).token, "e".repeat(32),
    "resource transaction quarantine restore damaged the replacement lock generation");
  const retainedQuarantines = readdirSync(root).filter((name) => name.startsWith("transaction.lock.stale."));
  assert(retainedQuarantines.length === 1
    && JSON.parse(readFileSync(join(root, retainedQuarantines[0], "owner.json"), "utf8")).token === "f".repeat(32),
  "resource transaction restore race did not retain the quarantined observed generation for inspection");
  rmSync(legacyLock, { recursive: true, force: true });
  rmSync(join(root, retainedQuarantines[0]), { recursive: true, force: true });

  const light = await coordinator.acquire(resourceCommandProfile("/bin/ps", ["-axo", "pid=,ppid="]));
  assert.equal(light.active, false);
  const lease = await coordinator.acquire(cargo, { cwd: root });
  assert.equal(lease.active, true);
  let snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(snapshot.active_leases, 1);
  assert.equal(snapshot.resources.cpu, 3);
  await lease.bindProcess({ pid: process.pid }, { processGroupIsolated: false });
  const files = await import("node:fs").then((fs) => fs.readdirSync(join(root, "leases")));
  const persisted = JSON.parse(readFileSync(join(root, "leases", files[0]), "utf8"));
  assert.equal(persisted.owner.kind, "process");
  assert.equal(persisted.owner.pid, process.pid);
  assert(!JSON.stringify(persisted).includes(root), "resource lease exposed a raw project path");
  await lease.bindProcess({ pid: process.pid }, { processGroupIsolated: false });
  await assert.rejects(() => lease.bindProcess({ pid: process.ppid }, { processGroupIsolated: false }), /different process ownership semantics/,
    "a bound resource lease could be rebound to a different process generation");
  if (process.platform !== "win32") {
    await assert.rejects(() => lease.bindProcess({ pid: process.pid }, { processGroupIsolated: true }), /different process ownership semantics/,
      "a bound resource lease treated a changed process-group isolation contract as an idempotent bind");
  }
  assert.equal(await lease.release(), true);
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(snapshot.active_leases, 0);

  const unboundedNinja = resourceCommandProfile("ninja", ["-j0", "all"]);
  const idleGreen = { ...green, cpu_busy_cores: 0, load1: 0 };
  const unboundedDecision = evaluateResourceAdmission(idleGreen, [], unboundedNinja, Date.now());
  assert.equal(unboundedDecision.reservation.cpu, greenLimits.cpu,
    "unbounded admission decision did not expose the conservative CPU reservation it actually evaluated");
  const unboundedCoordinator = new ResourceCoordinator({
    root: `${root}-unbounded`, now: () => now, sampleHost: () => ({ ...idleGreen, sampled_at_ms: now }), sleep: async () => {}, random: () => 0,
  });
  const unboundedLease = await unboundedCoordinator.acquire(unboundedNinja, { cwd: root });
  assert.equal(unboundedLease.request.cpu, greenLimits.cpu,
    "unbounded durable lease persisted the smaller profile hint instead of the CPU reservation used for admission");
  const unboundedSnapshot = await unboundedCoordinator.snapshot({ cwd: root });
  assert.equal(unboundedSnapshot.resources.cpu, greenLimits.cpu,
    "unbounded durable accounting shrank after admission and reopened capacity too early");
  await unboundedLease.release();

  const corruptedReleaseLease = await coordinator.acquire(cargo, { cwd: root });
  const corruptedLeasePath = join(root, "leases", `lease_${corruptedReleaseLease.id}.json`);
  const corruptedLeaseAlias = join(root, "lease-hardlink-alias.json");
  linkSync(corruptedLeasePath, corruptedLeaseAlias);
  await assert.rejects(() => corruptedReleaseLease.release(), /hard link|multiple/i,
    "lease ownership corruption was silently treated as a successful release");
  assert.equal(corruptedReleaseLease.active, true, "failed corrupted lease release made the handle non-retryable");
  rmSync(corruptedLeaseAlias, { force: true });
  assert.equal(await corruptedReleaseLease.release(), true, "lease could not be released after ownership corruption was repaired");

  if (process.platform !== "win32") {
    const detachedLease = await coordinator.acquire(resourceCommandProfile(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"]), { cwd: root });
    const detachedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { detached: true, stdio: "ignore" });
    await new Promise((resolvePromise, rejectPromise) => {
      detachedChild.once("spawn", resolvePromise);
      detachedChild.once("error", rejectPromise);
    });
    let detachedCleanupError = null;
    try {
      await detachedLease.bindProcess(detachedChild, { processGroupIsolated: true });
      assert.equal(await detachedLease.release(), true);
      snapshot = await coordinator.snapshot({ cwd: root });
      assert.equal(snapshot.active_leases, 1, "explicit release dropped a still-live isolated process group");
    } finally {
      try { process.kill(-detachedChild.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") detachedCleanupError = error; }
      if (detachedChild.exitCode === null) await new Promise((resolvePromise) => { detachedChild.once("close", resolvePromise); });
    }
    if (detachedCleanupError) throw detachedCleanupError;
    snapshot = await coordinator.snapshot({ cwd: root });
    assert.equal(snapshot.active_leases, 0, "dead released process group lease was not pruned");

    const reusedGroupLease = await coordinator.acquire(resourceCommandProfile(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"]), { cwd: root });
    const reusedGroupChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { detached: true, stdio: "ignore" });
    await new Promise((resolvePromise, rejectPromise) => {
      reusedGroupChild.once("spawn", resolvePromise);
      reusedGroupChild.once("error", rejectPromise);
    });
    let reusedGroupCleanupError = null;
    try {
      await reusedGroupLease.bindProcess(reusedGroupChild, { processGroupIsolated: true });
      const reusedGroupPath = join(root, "leases", `lease_${reusedGroupLease.id}.json`);
      const reusedGroupRecord = JSON.parse(readFileSync(reusedGroupPath, "utf8"));
      reusedGroupRecord.owner.process_started_at = new Date(Date.parse(reusedGroupRecord.owner.process_started_at) - 60_000).toISOString();
      writeFileSync(reusedGroupPath, `${JSON.stringify(reusedGroupRecord)}\n`, { mode: 0o600 });
      assert.equal(await reusedGroupLease.release(), true,
        "PID-generation mismatch prevented release of an isolated lease whose numeric process group was reused");
      snapshot = await coordinator.snapshot({ cwd: root });
      assert.equal(snapshot.active_leases, 0,
        "a live numeric process group overrode process-generation evidence and kept a stale lease alive");
    } finally {
      try { process.kill(-reusedGroupChild.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") reusedGroupCleanupError = error; }
      if (reusedGroupChild.exitCode === null) await new Promise((resolvePromise) => { reusedGroupChild.once("close", resolvePromise); });
    }
    if (reusedGroupCleanupError) throw reusedGroupCleanupError;
  }

  const committedId = "a".repeat(32);
  const committed = join(root, "leases", `lease_${committedId}.json`);
  writeFileSync(committed, `${JSON.stringify({
    schema_version: 1, lease_id: committedId, token: "b".repeat(64),
    acquired_at: new Date(now - 60_000).toISOString(), bound_at: null, project_hash: "c".repeat(24),
    owner: { kind: "provisional", pid: 99999999, process_started_at: new Date(now - 60_000).toISOString() },
    request: { ...cargo, contention_key: null },
  })}\n`, { mode: 0o600 });
  const committedStaging = join(root, "leases", `.lease_${committedId}.json.${process.pid}.${"d".repeat(16)}.tmp`);
  linkSync(committed, committedStaging);
  const stalePruneSignal = resourceChangeSignal(coordinator);
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(stalePruneSignal.aborted, true, "stale lease pruning did not wake same-daemon capacity waiters");
  assert.equal(snapshot.active_leases, 0, "dead committed staging alias prevented stale lease pruning");
  assert.equal(await import("node:fs").then((fs) => fs.existsSync(committedStaging)), false, "committed staging alias was not recovered");
  createResourceWaiter(join(root, "waiters"), cargo, 0, now - 20_000);
  const staleWaiterSignal = resourceChangeSignal(coordinator);
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(staleWaiterSignal.aborted, true, "expired waiter pruning did not wake same-daemon fairness waiters");
  assert.equal(snapshot.waiters.active, 0, "expired waiter survived coordinator pruning");

  const replacementLease = await coordinator.acquire(cargo, { cwd: root });
  const replacement = join(root, "leases", `lease_${replacementLease.id}.json`);
  const replacementBefore = readFileSync(replacement, "utf8");
  const replacementStaging = join(root, "leases", `.lease_${replacementLease.id}.json.99999999.${"2".repeat(16)}.tmp`);
  writeFileSync(replacementStaging, "uncommitted replacement", { mode: 0o600 });
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(snapshot.active_leases, 1);
  assert.equal(readFileSync(replacement, "utf8"), replacementBefore, "staging recovery modified the published target");
  assert.equal(await import("node:fs").then((fs) => fs.existsSync(replacementStaging)), false, "dead replacement staging file was not recovered");
  await replacementLease.release();

  const orphanId = "e".repeat(32);
  const orphanStaging = join(root, "leases", `.lease_${orphanId}.json.99999999.${"f".repeat(16)}.tmp`);
  writeFileSync(orphanStaging, "uncommitted", { mode: 0o600 });
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(snapshot.active_leases, 0);
  assert.equal(await import("node:fs").then((fs) => fs.existsSync(orphanStaging)), false, "dead uncommitted staging file was not recovered");

  const liveStagingId = "9".repeat(32);
  const liveStaging = join(root, "leases", `.lease_${liveStagingId}.json.${process.pid}.${"1".repeat(16)}.tmp`);
  writeFileSync(liveStaging, "publisher-still-live", { mode: 0o600 });
  await assert.rejects(
    () => coordinator.snapshot({ cwd: root }),
    (error) => error?.code === RESOURCE_STAGING_BUSY_CODE && /staging file is still owned by a live publisher/.test(error.message),
    "live publisher staging was reclaimed as a crash artifact",
  );
  rmSync(liveStaging, { force: true });

  const transientRoot = `${root}-live-staging-retry`;
  let transientStaging = "";
  let transientStagingWaits = 0;
  const transientCoordinator = new ResourceCoordinator({
    root: transientRoot,
    now: () => now,
    sampleHost: () => ({ ...green, sampled_at_ms: now }),
    random: () => 0,
    sleep: async () => {
      transientStagingWaits += 1;
      if (transientStaging) rmSync(transientStaging, { force: true });
    },
  });
  await transientCoordinator.snapshot({ cwd: transientRoot });
  const transientId = "7".repeat(32);
  transientStaging = join(transientRoot, "leases", `.lease_${transientId}.json.${process.pid}.${"6".repeat(16)}.tmp`);
  writeFileSync(transientStaging, "publisher-settling", { mode: 0o600 });
  const transientSnapshot = await transientCoordinator.snapshot({ cwd: transientRoot });
  assert.equal(transientSnapshot.active_leases, 0, "transient live publisher became an admitted lease");
  assert.equal(transientStagingWaits, 1, "resource coordinator did not perform one bounded retry for transient live staging");
  assert.equal((await import("node:fs")).existsSync(transientStaging), false, "transient publisher staging survived its simulated settlement");
  rmSync(transientRoot, { recursive: true, force: true });

  const reusedPublisherId = "8".repeat(32);
  const reusedPublisherStaging = join(root, "leases", `.lease_${reusedPublisherId}.json.${process.pid}.${"7".repeat(16)}.tmp`);
  writeFileSync(reusedPublisherStaging, "stale-publisher-generation", { mode: 0o600 });
  const beforeCurrentProcess = new Date(currentProcessStartTimeMs() - 60_000);
  utimesSync(reusedPublisherStaging, beforeCurrentProcess, beforeCurrentProcess);
  snapshot = await coordinator.snapshot({ cwd: root });
  assert.equal(snapshot.active_leases, 0);
  assert.equal(await import("node:fs").then((fs) => fs.existsSync(reusedPublisherStaging)), false,
    "reused publisher PID kept a stale resource staging artifact alive");

  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const firstProjectLease = await coordinator.acquire(scriptHeavy, { cwd: projectA });
  now += 6_000;
  await assert.rejects(() => coordinator.acquire(scriptHeavy, { cwd: projectA }), (error) => error instanceof ResourceAdmissionError && error.decision?.reason === "project_resource_busy");
  const otherProjectLease = await coordinator.acquire(scriptHeavy, { cwd: projectB });
  assert.equal(otherProjectLease.active, true, "different projects were incorrectly serialized");
  await otherProjectLease.release();
  await firstProjectLease.release();

  let ancestrySamples = 0;
  const nestedCoordinator = new ResourceCoordinator({
    root: `${root}-nested`,
    sampleHost: () => ({ ...green, sampled_at_ms: Date.now(), cpu_busy_cores: 0, load1: 0 }),
    sampleProcessParents: () => { ancestrySamples += 1; return { [String(process.pid)]: process.ppid }; },
    random: () => 0,
  });
  const nestedParent = await nestedCoordinator.acquire(scriptHeavy, { cwd: root });
  assert.equal(ancestrySamples, 0, "empty lease set still paid for a full process-ancestry scan");
  await nestedParent.bindProcess({ pid: process.pid }, { processGroupIsolated: false });
  const nestedChild = await nestedCoordinator.acquire(scriptHeavy, { cwd: root });
  assert.equal(ancestrySamples, 1, "active lease set skipped the ancestry sample required for nested accounting");
  assert.equal(nestedChild.active, true, "nested coordinator request self-blocked on its ancestor envelope");
  await nestedChild.release();
  await nestedParent.release();

  const reboundRoot = `${root}-elastic-rebound`;
  let reboundNow = Date.now(); let reboundSamples = 0; const evaluatedJobs = []; const persistedJobs = [];
  const reboundCoordinator = new ResourceCoordinator({
    root: reboundRoot, now: () => reboundNow, random: () => 0,
    sampleHost: () => ({ ...green, sampled_at_ms: reboundNow, cpu_busy_cores: reboundSamples++ === 0 ? 5.7 : 1, load1: 0 }),
    evaluate: (host, _leases, request) => {
      evaluatedJobs.push(request.compiler_jobs);
      return host.cpu_busy_cores > 2
        ? { admitted: false, state: "green", reason: "project_resource_busy" }
        : { admitted: true, state: "green", reason: "admitted_green" };
    },
    sleep: async () => {
      const files = readdirSync(join(reboundRoot, "waiters")).filter((name) => name.startsWith("wait_"));
      assert.equal(files.length, 1, "elastic retry replaced its waiter instead of preserving queue age");
      persistedJobs.push(JSON.parse(readFileSync(join(reboundRoot, "waiters", files[0]), "utf8")).request.compiler_jobs);
      reboundNow += 600;
    },
  });
  const reboundLease = await reboundCoordinator.acquire(cargo, { cwd: root, waitMs: 1_000 });
  assert.equal(persistedJobs[0], 1, "first constrained iteration did not persist the fitted worker count");
  assert(evaluatedJobs.includes(1) && evaluatedJobs.includes(3), "elastic waiter did not reevaluate both constrained and recovered fan-out");
  assert.equal(reboundLease.request.compiler_jobs, 3, "elastic waiter failed to re-expand after host capacity recovered");
  await reboundLease.release();
  rmSync(reboundRoot, { recursive: true, force: true });

  const wakeRoot = `${root}-waiter-wake`; let wakeSleeps = 0;
  const wakeCoordinator = new ResourceCoordinator({
    root: wakeRoot, sampleHost: () => ({ ...green, sampled_at_ms: Date.now(), cpu_busy_cores: 0, load1: 0 }), random: () => 0,
    evaluate: () => ({ admitted: false, state: "green", reason: "fairness_wait" }),
    sleep: async (_ms, signal) => {
      if (!signal) return;
      wakeSleeps += 1;
      await new Promise((resolvePromise, rejectPromise) => {
        const onAbort = () => rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const firstCancel = new AbortController(); const secondCancel = new AbortController();
  const firstWait = wakeCoordinator.acquire(cargo, { cwd: root, waitMs: 5_000, signal: firstCancel.signal }).then(() => null, (error) => error);
  const secondWait = wakeCoordinator.acquire(cargo, { cwd: root, waitMs: 5_000, signal: secondCancel.signal }).then(() => null, (error) => error);
  for (let attempts = 0; wakeSleeps < 2 && attempts < 100; attempts += 1) await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
  assert(wakeSleeps >= 2, "parallel waiters did not enter their admission waits");
  firstCancel.abort(new Error("first waiter cancelled"));
  for (let attempts = 0; wakeSleeps < 3 && attempts < 100; attempts += 1) await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
  assert(wakeSleeps >= 3, "removing a cancelled waiter did not wake a same-daemon peer for immediate fairness reevaluation");
  secondCancel.abort(new Error("second waiter cancelled"));
  assert.match((await firstWait)?.message || "", /first waiter cancelled/); assert.match((await secondWait)?.message || "", /second waiter cancelled/);
  rmSync(wakeRoot, { recursive: true, force: true });

  let quickMode = null;
  const samplingCoordinator = new ResourceCoordinator({
    root: `${root}-sampling`,
    sampleHost: (options) => { quickMode = options.quick; return { ...green, sampled_at_ms: Date.now(), io_sampled: options.quick !== true }; },
  });
  const adaptiveLease = await samplingCoordinator.acquire(resourceCommandProfile("python3", ["script.py"]), { cwd: root });
  assert.equal(quickMode, true, "adaptive command paid for full I/O sampling");
  await adaptiveLease.release();
  quickMode = null;
  const heavyLease = await samplingCoordinator.acquire(cargo, { cwd: root });
  assert.notEqual(quickMode, false, "mixed CPU/build work paid for a blocking fresh I/O probe");
  await heavyLease.release();
  quickMode = null;
  const ioLease = await samplingCoordinator.acquire(resourceCommandProfile("git", ["add", "."]), { cwd: root });
  assert.equal(quickMode, false, "I/O-dominant work skipped fresh I/O pressure sampling");
  await ioLease.release();

  let releaseSingleFlight;
  const singleFlightGate = new Promise((resolvePromise) => { releaseSingleFlight = resolvePromise; });
  let singleFlightSamples = 0;
  const singleFlightCoordinator = new ResourceCoordinator({
    root: `${root}-singleflight`,
    sampleHost: async (options) => {
      singleFlightSamples += 1;
      await singleFlightGate;
      return { ...green, sampled_at_ms: Date.now(), io_sampled: options.quick !== true };
    },
  });
  singleFlightCoordinator.ensureRoot();
  const sharedQuickA = singleFlightCoordinator.freshHostSnapshot(root, resourceCommandProfile("python3", ["script.py"]));
  const sharedQuickB = singleFlightCoordinator.freshHostSnapshot(root, cargo);
  await Promise.resolve();
  assert.equal(singleFlightSamples, 1, "concurrent host admission probes did not share one in-flight sample");
  releaseSingleFlight();
  await Promise.all([sharedQuickA, sharedQuickB]);
  let crossScopeSamples = 0;
  const crossScopeCoordinator = new ResourceCoordinator({
    root: `${root}-cross-scope`,
    sampleHost: async () => { crossScopeSamples += 1; return { ...green, sampled_at_ms: Date.now() }; },
  });
  crossScopeCoordinator.ensureRoot();
  await crossScopeCoordinator.freshHostSnapshot(projectA, cargo);
  await crossScopeCoordinator.freshHostSnapshot(projectB, cargo);
  assert.equal(crossScopeSamples, 2, "host sample cache crossed filesystem/project scope and could reuse the wrong disk headroom");

  const blockedCoordinator = new ResourceCoordinator({
    root: `${root}-blocked`,
    sampleHost: () => ({ ...red, sampled_at_ms: Date.now() }),
    sleep: async () => {}, random: () => 0,
  });
  await assert.rejects(() => blockedCoordinator.acquire(cargo), (error) => error instanceof ResourceAdmissionError && error.retryable === true);
  let structuralSleeps = 0;
  const structurallyBlockedCoordinator = new ResourceCoordinator({
    root: `${root}-structural-cpu`,
    sampleHost: () => ({ ...quietInteractiveHost, sampled_at_ms: Date.now() }),
    sleep: async () => { structuralSleeps += 1; }, random: () => 0,
  });
  await assert.rejects(
    () => structurallyBlockedCoordinator.acquire(explicitPytestEight, { cwd: root, waitMs: 300_000 }),
    (error) => error instanceof ResourceAdmissionError
      && error.retryable === false
      && error.decision?.reason === "cpu_request_exceeds_launch_window",
    "structurally impossible fixed CPU fan-out did not fail without a pointless long retry window",
  );
  assert.equal(structuralSleeps, 0, "structurally impossible fixed CPU fan-out entered the resource retry sleep loop");
  const livenessCoordinator = new ResourceCoordinator({
    root: `${root}-liveness`, sampleHost: () => ({ ...red, sampled_at_ms: Date.now() }), random: () => 0,
  });
  await assert.rejects(
    () => livenessCoordinator.acquire(cargo, { waitMs: 75 }),
    (error) => error instanceof ResourceAdmissionError && error.retryable === true,
    "real admission wait did not remain alive until its deadline",
  );

  const abortController = new AbortController();
  assert.equal(resourceRetryDelayMs({ attempt: 0, priority: "interactive", remainingMs: 5_000, random: () => 0 }), 100);
  assert.equal(resourceRetryDelayMs({ attempt: 2, priority: "interactive", remainingMs: 5_000, random: () => 0 }), 400);
  assert.equal(resourceRetryDelayMs({ attempt: 0, priority: "background", remainingMs: 5_000, random: () => 0 }), 500);
  assert.equal(resourceRetryDelayMs({ attempt: 0, priority: "ordinary", reason: "host_pressure_red", remainingMs: 5_000, random: () => 0 }), 600);
  assert.equal(resourceRetryDelayMs({ attempt: 0, priority: "ordinary", reason: "cpu_pressure_window", remainingMs: 5_000, random: () => 0 }), 300);
  assert.equal(resourceRetryDelayMs({ attempt: 4, priority: "background", remainingMs: 750, random: () => 1 }), 750,
    "resource retry delay exceeded the caller's remaining wait budget");
  const wakeOwner = {};
  const wakeSignal = resourceChangeSignal(wakeOwner);
  assert.equal(resourceChangeSignal(wakeOwner), wakeSignal, "unchanged resource capacity rotated its wake signal spuriously");
  const releaseWake = waitForResourceChange(wakeSignal, 5_000);
  setTimeout(() => signalResourceChange(wakeOwner), 5);
  assert.equal(await releaseWake, true, "same-daemon resource release did not wake a waiter before its retry timer");
  assert.equal(resourceChangeSignal(wakeOwner).aborted, false, "resource release did not rotate to a fresh wake signal");
  assert.equal(await waitForResourceChange(resourceChangeSignal(wakeOwner), 5_000, async () => {}), false,
    "ordinary retry timeout was misclassified as a resource-change wakeup");
  const externalAbort = new AbortController();
  const externalAbortWait = waitForResourceChange(resourceChangeSignal({}), 5_000, resourceSleep, externalAbort.signal);
  externalAbort.abort(new Error("external resource wait cancelled"));
  await assert.rejects(externalAbortWait, /external resource wait cancelled/,
    "caller cancellation was misclassified as a resource-capacity change");
  const unobservedOwner = {};
  signalResourceChange(unobservedOwner);
  assert.equal(resourceChangeSignal(unobservedOwner).aborted, false,
    "capacity change without a current waiter published an already-aborted signal");
  const abortedWait = resourceSleep(5_000, abortController.signal);
  setTimeout(() => abortController.abort(new Error("resource wait aborted")), 5);
  await assert.rejects(abortedWait, /resource wait aborted/);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("resource wait already aborted"));
  await assert.rejects(resourceSleep(5_000, alreadyAborted.signal), /resource wait already aborted/);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-blocked`, { recursive: true, force: true });
  rmSync(`${root}-structural-cpu`, { recursive: true, force: true });
  rmSync(`${root}-sampling`, { recursive: true, force: true });
  rmSync(`${root}-singleflight`, { recursive: true, force: true });
  rmSync(`${root}-cross-scope`, { recursive: true, force: true });
  rmSync(`${root}-liveness`, { recursive: true, force: true });
  rmSync(`${root}-nested`, { recursive: true, force: true });
  rmSync(`${root}-unbounded`, { recursive: true, force: true });
}
console.log("resource admission test ok");

function resourceLease(id, pid, request, boundMs) {
  return {
    lease_id: id,
    acquired_at: new Date(boundMs).toISOString(),
    bound_at: new Date(boundMs).toISOString(),
    owner: { kind: "process", pid, process_group_id: pid, process_group_isolated: true },
    request,
  };
}

function waiter(priority, enqueuedMs, request, id) {
  return {
    waiter_id: id,
    enqueued_at: new Date(enqueuedMs).toISOString(),
    request: { ...request, priority },
  };
}

function host() {
  return {
    sampled_at_ms: Date.now(), cpu_cores: 8, total_memory_mb: 16 * 1024,
    cpu_busy_cores: 1.5, load1: 2, memory_free_percent: 40,
    pageouts_total: 100, swapouts_total: 20, pageouts_per_s: 0, swapouts_per_s: 0,
    disk_mb_per_s: 5, disk_iops: 200, disk_free_bytes: 125 * GIB,
    disk_total_bytes: 460 * GIB, thermal_warning: false,
  };
}
