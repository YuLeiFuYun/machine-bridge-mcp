import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareResourceBuildCommand, projectBuildHash } from "../src/local/resource-build-root.mjs";
import { ResourceAdmissionError } from "../src/local/resource-admission.mjs";
import { acquireProcessResources, bindProcessResources, releaseProcessResources } from "../src/local/resource-process-admission.mjs";
import { applyResourceProfileEnv, resourceCommandProfile } from "../src/local/resource-command-profile.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-agent-build-root-"));
const project = mkdtempSync(join(tmpdir(), "mbm-agent-build-project-"));
try {
  const cargoRequest = resourceCommandProfile("cargo", ["test"]);
  const cargo = prepareResourceBuildCommand("cargo", ["test"], applyResourceProfileEnv({}, cargoRequest), cargoRequest, project, { root });
  assert.equal(cargo.environment.CARGO_BUILD_JOBS, "3");
  assert.equal(cargo.environment.CARGO_TARGET_DIR, join(root, "cargo", projectBuildHash(project)));
  assert.equal(cargo.environment.AGENT_BUILD_ROOT, root);
  assert(existsSync(cargo.environment.CARGO_TARGET_DIR), "Cargo shared target directory was not created");
  const relativeCargoRequest = resourceCommandProfile("cargo", ["test"], { environment: { CARGO_BUILD_JOBS: "-1" } });
  const relativeCargo = prepareResourceBuildCommand("cargo", ["test"], applyResourceProfileEnv({ CARGO_BUILD_JOBS: "-1" }, relativeCargoRequest), relativeCargoRequest, project, { root });
  assert.equal(relativeCargo.environment.CARGO_BUILD_JOBS, "-1", "relative explicit CARGO_BUILD_JOBS was overwritten by its resolved numeric admission value");
  if (process.platform === "darwin") assert(existsSync(join(root, ".metadata_never_index")), "macOS build root lost Spotlight exclusion marker");

  const explicitCargo = prepareResourceBuildCommand("cargo", ["test"], { CARGO_TARGET_DIR: "/explicit/target" }, cargoRequest, project, { root });
  assert.equal(explicitCargo.environment.CARGO_TARGET_DIR, "/explicit/target", "explicit Cargo target directory was overridden");

  const swiftRequest = resourceCommandProfile("swift", ["test"]);
  const swift = prepareResourceBuildCommand("swift", ["test", "--filter", "Thing"], {}, swiftRequest, project, { root });
  assert.deepEqual(swift.args.slice(0, 5), ["test", "-j", "3", "--scratch-path", join(root, "swift", projectBuildHash(project))]);
  const explicitSwift = prepareResourceBuildCommand("swift", ["test", "--scratch-path", "/explicit/swift", "-j", "2"], {}, swiftRequest, project, { root });
  assert.equal(explicitSwift.args.filter((value) => value === "--scratch-path").length, 1);
  assert.equal(explicitSwift.args.filter((value) => value === "-j").length, 1);
  const repeatedSwiftRequest = resourceCommandProfile("swift", ["test", "-j", "2", "--jobs=8"]);
  const repeatedSwift = prepareResourceBuildCommand("swift", ["test", "-j", "2", "--jobs=8"], {}, repeatedSwiftRequest, project, { root });
  assert.deepEqual(repeatedSwift.args.filter((value) => value === "-j" || value.startsWith("--jobs")), ["-j", "--jobs=8"],
    "SwiftPM last-wins concurrency was duplicated by an injected worker cap");
  const invalidSwiftRequest = resourceCommandProfile("swift", ["test", "-j8"]);
  assert.deepEqual(prepareResourceBuildCommand("swift", ["test", "-j8"], {}, invalidSwiftRequest, project, { root }).args, ["test", "-j8"],
    "invalid pre-build SwiftPM concurrency was rewritten before Swift Argument Parser could report it");

  const xcodeRequest = resourceCommandProfile("xcodebuild", ["test"]);
  const xcode = prepareResourceBuildCommand("xcodebuild", ["test", "-scheme", "App"], {}, xcodeRequest, project, { root });
  assert.deepEqual(xcode.args.slice(0, 4), ["-jobs", "3", "-derivedDataPath", join(root, "xcode", projectBuildHash(project))]);
  const explicitXcodeRequest = resourceCommandProfile("xcodebuild", ["test", "-jobs", "2"]);
  const explicitXcode = prepareResourceBuildCommand("xcodebuild", ["-jobs", "2", "-derivedDataPath", "/explicit/xcode", "test"], {}, explicitXcodeRequest, project, { root });
  assert.equal(explicitXcode.args.filter((value) => value === "-jobs").length, 1);
  assert.equal(explicitXcode.args.filter((value) => value === "-derivedDataPath").length, 1);
  const equalsXcodeRequest = resourceCommandProfile("xcodebuild", ["build", "-jobs=2"]);
  const equalsXcode = prepareResourceBuildCommand("xcodebuild", ["build", "-jobs=2"], {}, equalsXcodeRequest, project, { root });
  assert.equal(equalsXcodeRequest.unbounded, true, "Xcode equals-form jobs token was treated as a native hard bound");
  assert.equal(equalsXcode.args.includes("-jobs"), false, "unbounded Xcode equals-form jobs token gained a synthetic hard cap");
  const xcodeHelpRequest = resourceCommandProfile("xcodebuild", ["-help"]);
  assert.deepEqual(prepareResourceBuildCommand("xcodebuild", ["-help"], {}, xcodeHelpRequest, project, { root }).args, ["-help"],
    "xcodebuild help was polluted by build-root flags");
  for (const args of [["-resolvePackageDependencies"], ["-showBuildSettings"], ["-exportArchive"]]) {
    const request = resourceCommandProfile("xcodebuild", args);
    assert.deepEqual(prepareResourceBuildCommand("xcodebuild", args, {}, request, project, { root }).args, args,
      `non-build Xcode mode ${args[0]} was polluted by build-root flags`);
  }
  const invalidXcodeRequest = resourceCommandProfile("xcodebuild", ["build", "-jobs", "0"]);
  assert.deepEqual(prepareResourceBuildCommand("xcodebuild", ["build", "-jobs", "0"], {}, invalidXcodeRequest, project, { root }).args,
    ["build", "-jobs", "0"], "invalid pre-build Xcode jobs were rewritten before xcodebuild could report them");

  const boundedGeneric = [
    ["make", ["all"], ["-j", "3", "all"]],
    ["ninja", ["test"], ["-j", "3", "test"]],
    ["cmake", ["--build", "build"], ["--build", "build", "--parallel", "3"]],
    ["gradle", ["test"], ["--max-workers", "3", "test"]],
    ["./gradlew", ["test"], ["--max-workers", "3", "test"]],
    ["mvn", ["test"], ["-T", "3", "test"]],
    ["./mvnw", ["test"], ["-T", "3", "test"]],
    ["go", ["test", "./..."], ["test", "-p", "3", "./..."]],
  ];
  for (const [command, args, expected] of boundedGeneric) {
    const request = resourceCommandProfile(command, args);
    assert.equal(request.unbounded, false, `${command} direct build remained unbounded`);
    assert.deepEqual(prepareResourceBuildCommand(command, args, {}, request, project, { root }).args, expected,
      `${command} default worker bound was not enforced on argv`);
  }
  const explicitMakeRequest = resourceCommandProfile("make", ["-j2", "all"]);
  assert.deepEqual(prepareResourceBuildCommand("make", ["-j2", "all"], {}, explicitMakeRequest, project, { root }).args, ["-j2", "all"],
    "explicit generic-build concurrency was overwritten");
  const clusteredMakeRequest = resourceCommandProfile("make", ["-kj8", "all"]);
  assert.deepEqual(prepareResourceBuildCommand("make", ["-kj8", "all"], {}, clusteredMakeRequest, project, { root }).args, ["-kj8", "all"],
    "clustered GNU make concurrency was duplicated by an injected worker cap");
  const repeatedNinjaRequest = resourceCommandProfile("ninja", ["-j2", "-j8", "all"]);
  assert.deepEqual(prepareResourceBuildCommand("ninja", ["-j2", "-j8", "all"], {}, repeatedNinjaRequest, project, { root }).args,
    ["-j2", "-j8", "all"], "repeated explicit Ninja concurrency was rewritten after last-wins accounting");
  const invalidNinjaRequest = resourceCommandProfile("ninja", ["-j-1", "all"]);
  assert.deepEqual(prepareResourceBuildCommand("ninja", ["-j-1", "all"], {}, invalidNinjaRequest, project, { root }).args,
    ["-j-1", "all"], "invalid Ninja concurrency was rewritten before Ninja could report it");
  const mavenCoreRequest = resourceCommandProfile("mvn", ["-T2.5C", "test"]);
  assert.deepEqual(prepareResourceBuildCommand("mvn", ["-T2.5C", "test"], {}, mavenCoreRequest, project, { root }).args,
    ["-T2.5C", "test"], "explicit Maven core-multiplier concurrency was overwritten");
  const mavenArgsRequest = resourceCommandProfile("mvn", ["test"], { environment: { MAVEN_ARGS: "-T6" } });
  assert.deepEqual(prepareResourceBuildCommand("mvn", ["test"], { MAVEN_ARGS: "-T6" }, mavenArgsRequest, project, { root }).args,
    ["test"], "prepended MAVEN_ARGS concurrency was duplicated by a later command-line worker cap");
  const cmakeEnvironmentRequest = resourceCommandProfile("cmake", ["--build", "build"], { environment: { CMAKE_BUILD_PARALLEL_LEVEL: "8" } });
  assert.deepEqual(prepareResourceBuildCommand("cmake", ["--build", "build"], { CMAKE_BUILD_PARALLEL_LEVEL: "8" }, cmakeEnvironmentRequest, project, { root }).args,
    ["--build", "build"], "explicit CMake environment concurrency was overwritten by a higher-precedence argv cap");
  for (const args of [["--build", "build", "--parallel8"], ["--build", "build", "-j=7"]]) {
    const request = resourceCommandProfile("cmake", args);
    assert.deepEqual(prepareResourceBuildCommand("cmake", args, {}, request, project, { root }).args, args,
      `explicit CMake concurrency ${args.at(-1)} was duplicated by an injected --parallel cap`);
  }
  for (const args of [["--build", "--preset", "fast"], ["--build", "build", "--parallel=2", "--", "-j8"]]) {
    const request = resourceCommandProfile("cmake", args);
    assert.equal(request.unbounded, true, "CMake preset/native-tool fan-out was not fail-closed before build command preparation");
    assert.deepEqual(prepareResourceBuildCommand("cmake", args, {}, request, project, { root }).args, args,
      "CMake preset/native-tool coordination was changed by a guessed local worker cap");
  }
  const invalidCmakeRequest = resourceCommandProfile("cmake", ["--build", "build", "--parallel=0"]);
  assert.deepEqual(prepareResourceBuildCommand("cmake", ["--build", "build", "--parallel=0"], {}, invalidCmakeRequest, project, { root }).args,
    ["--build", "build", "--parallel=0"], "invalid CMake concurrency was rewritten before CMake could report it");
  const makeEnvironmentRequest = resourceCommandProfile("make", ["all"], { environment: { MAKEFLAGS: "-j8" } });
  assert.deepEqual(prepareResourceBuildCommand("make", ["all"], { MAKEFLAGS: "-j8" }, makeEnvironmentRequest, project, { root }).args,
    ["all"], "MAKEFLAGS concurrency was overwritten by a command-line worker cap");
  const gnuMakeEnvironmentRequest = resourceCommandProfile("make", ["all"], { environment: { GNUMAKEFLAGS: "j8" } });
  assert.deepEqual(prepareResourceBuildCommand("make", ["all"], { GNUMAKEFLAGS: "j8" }, gnuMakeEnvironmentRequest, project, { root }).args,
    ["all"], "GNUMAKEFLAGS concurrency was overwritten by a command-line worker cap");
  if (process.platform !== "win32") {
    const ninjaJobserverEnvironment = { MAKEFLAGS: "-j8 --jobserver-auth=fifo:/tmp/ninja-jobs" };
    const ninjaJobserverRequest = resourceCommandProfile("ninja", ["all"], { environment: ninjaJobserverEnvironment });
    assert.deepEqual(prepareResourceBuildCommand("ninja", ["all"], ninjaJobserverEnvironment, ninjaJobserverRequest, project, { root }).args,
      ["all"], "Ninja GNU jobserver coordination was disabled by an injected -j cap");
  }
  const goEnvironmentRequest = resourceCommandProfile("go", ["test", "./..."], { environment: { GOFLAGS: "'-p=6'" } });
  assert.deepEqual(prepareResourceBuildCommand("go", ["test", "./..."], { GOFLAGS: "'-p=6'" }, goEnvironmentRequest, project, { root }).args,
    ["test", "./..."], "quoted GOFLAGS concurrency was overwritten by a command-line worker cap");
  const directGoRequest = resourceCommandProfile("go", ["test", "--p=7", "./..."]);
  assert.deepEqual(prepareResourceBuildCommand("go", ["test", "--p=7", "./..."], {}, directGoRequest, project, { root }).args,
    ["test", "--p=7", "./..."], "explicit Go --p concurrency was duplicated by an injected -p cap");
  const invalidGoRequest = resourceCommandProfile("go", ["test", "-p=0", "./..."]);
  assert.deepEqual(prepareResourceBuildCommand("go", ["test", "-p=0", "./..."], {}, invalidGoRequest, project, { root }).args,
    ["test", "-p=0", "./..."], "invalid pre-build Go concurrency was rewritten before the go command could report it");
  const gradleEnvironmentRequest = resourceCommandProfile("./gradlew", ["test"], { environment: { GRADLE_OPTS: "-Dorg.gradle.workers.max=6" } });
  assert.deepEqual(prepareResourceBuildCommand("./gradlew", ["test"], { GRADLE_OPTS: "-Dorg.gradle.workers.max=6" }, gradleEnvironmentRequest, project, { root }).args,
    ["test"], "GRADLE_OPTS worker property was overwritten by --max-workers");
  const gradleJavaOptsRequest = resourceCommandProfile("./gradlew", ["test"], { environment: { JAVA_OPTS: "-Dorg.gradle.workers.max=7" } });
  assert.deepEqual(prepareResourceBuildCommand("./gradlew", ["test"], { JAVA_OPTS: "-Dorg.gradle.workers.max=7" }, gradleJavaOptsRequest, project, { root }).args,
    ["test"], "JAVA_OPTS worker property was overwritten by --max-workers");
  const gradleSystemRequest = resourceCommandProfile("./gradlew", ["-Dorg.gradle.workers.max=5", "test"]);
  assert.deepEqual(prepareResourceBuildCommand("./gradlew", ["-Dorg.gradle.workers.max=5", "test"], {}, gradleSystemRequest, project, { root }).args,
    ["-Dorg.gradle.workers.max=5", "test"], "Gradle worker system property was overwritten by --max-workers");
  for (const args of [["--max-workers=0", "test"], ["--max-workers=2", "--max-workers=8", "test"]]) {
    const invalidGradleRequest = resourceCommandProfile("./gradlew", args);
    assert.deepEqual(prepareResourceBuildCommand("./gradlew", args, {}, invalidGradleRequest, project, { root }).args, args,
      "invalid Gradle worker options were rewritten before Gradle could report them");
  }

  const bypass = await acquireProcessResources(null, "echo", ["ok"], { PATH: "/bin" }, { cwd: project });
  assert.equal(bypass.lease, null);
  assert.equal(bypass.request, null);
  assert.equal(bypass.environment.PATH, "/bin");

  const elasticAcquires = [];
  const elasticCoordinator = {
    acquire: async (request) => {
      elasticAcquires.push(request);
      const jobs = 2; const memory = request.family === "verification-plan" ? 2048 : request.memory_mb;
      return { request: { ...request, cpu: Math.min(request.cpu, jobs), compiler_jobs: jobs, memory_mb: memory }, release: async () => true };
    },
  };
  const fittedCargo = await acquireProcessResources(elasticCoordinator, "cargo", ["test"], { AGENT_BUILD_ROOT: root }, { cwd: project });
  assert.equal(elasticAcquires.at(-1).cpu, 3, "process layer pre-fit Cargo before coordinator admission");
  assert.equal(fittedCargo.request.compiler_jobs, 2, "process admission ignored the coordinator-selected Cargo request");
  assert.equal(fittedCargo.environment.CARGO_BUILD_JOBS, "2", "process environment did not enforce coordinator-selected Cargo fan-out");
  const fittedVerification = await acquireProcessResources(elasticCoordinator, "node", ["scripts/run-checks.mjs"], {}, { cwd: project });
  assert.equal(fittedVerification.request.compiler_jobs, 2, "process admission ignored the coordinator-selected verification fan-out");
  assert.equal(fittedVerification.request.memory_mb, 2048, "verification memory reservation did not follow the coordinator-selected request");
  assert.equal(fittedVerification.environment.MBM_CHECK_CONCURRENCY, "2", "verification environment did not enforce coordinator-selected fan-out");
  const serializedLeaseCoordinator = {
    acquire: async (request) => ({ request: JSON.parse(JSON.stringify(request)), release: async () => true }),
  };
  const preservedMake = await acquireProcessResources(serializedLeaseCoordinator, "make", ["all"], { MAKEFLAGS: "-j8" }, { cwd: project });
  assert.equal(preservedMake.request.cpu, 8, "serialized lease lost explicit MAKEFLAGS admission accounting");
  assert.deepEqual(preservedMake.args, ["all"], "serialized lease lost the in-memory marker that prevents overriding explicit MAKEFLAGS concurrency");

  const admissionCoordinator = {
    acquire: async () => { throw new ResourceAdmissionError({ state: "yellow", reason: "cpu_reservation" }); },
  };
  await assert.rejects(
    () => acquireProcessResources(admissionCoordinator, "cargo", ["test"], {}, { cwd: project }),
    (error) => error?.code === "unavailable" && error?.retryable === true
      && error?.details?.reason === "resource_admission"
      && error?.details?.pressure_state === "yellow"
      && error?.details?.admission_reason === "cpu_reservation",
  );

  let binds = 0;
  let successfulReleases = 0;
  const successfulLease = {
    bindProcess: async (_child, options) => { binds += 1; assert.equal(options.processGroupIsolated, process.platform !== "win32"); },
    release: async () => { successfulReleases += 1; return true; },
  };
  const successfulCoordinator = { acquire: async () => successfulLease };
  const preparedEcho = await acquireProcessResources(successfulCoordinator, "echo", ["ok"], { PATH: "/bin" }, { cwd: project });
  assert.equal(preparedEcho.request.family, "light");
  await bindProcessResources(preparedEcho.lease, { pid: process.pid });
  assert.equal(binds, 1);
  assert.equal(await releaseProcessResources(preparedEcho.lease), true);
  assert.equal(successfulReleases, 1);
  assert.equal(await releaseProcessResources(null), false);

  const invalidRoot = join(root, "not-a-directory");
  writeFileSync(invalidRoot, "file");
  let releases = 0;
  const fakeLease = { release: async () => { releases += 1; return true; } };
  const fakeCoordinator = { acquire: async () => fakeLease };
  await assert.rejects(
    () => acquireProcessResources(fakeCoordinator, "cargo", ["test"], { AGENT_BUILD_ROOT: invalidRoot }, { cwd: project, waitMs: 0 }),
  );
  assert.equal(releases, 1, "build-root preparation failure leaked its resource lease");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
console.log("resource build root test ok");
