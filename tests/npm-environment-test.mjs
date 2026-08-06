import assert from "node:assert/strict";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { resolveNpmGlobalPrefix } from "../scripts/npm-global-prefix.mjs";

const source = {
  PATH: "/example/bin",
  npm_config_dry_run: "true",
  NPM_CONFIG_DRY_RUN: "true",
  Npm_Config_Global: "true",
  npm_config_prefix: "/example/prefix",
  NPM_CONFIG_WORKSPACE: "fixture",
  NPM_CONFIG_WORKSPACES: "true",
  npm_config_ignore_scripts: "true",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
  npm_config_package_lock_only: "true",
  NPM_CONFIG_IF_PRESENT: "true",
  npm_config_json: "true",
  NPM_CONFIG_PARSEABLE: "true",
  npm_config_package_lock: "false",
  NPM_CONFIG_SHRINKWRAP: "false",
  npm_config_force: "true",
  NPM_CONFIG_LEGACY_PEER_DEPS: "true",
  npm_config_strict_peer_deps: "false",
  NPM_CONFIG_INSTALL_STRATEGY: "nested",
  npm_config_global_style: "true",
  npm_config_omit: "optional",
  npm_config_include: "dev",
  npm_config_production: "true",
  NPM_CONFIG_SAVE: "false",
  NPM_CONFIG_SAVE_DEV: "true",
  NPM_CONFIG_SAVE_OPTIONAL: "true",
  NPM_CONFIG_SAVE_PEER: "true",
  npm_config_registry: "https://registry.example.test",
  HTTPS_PROXY: "http://proxy.example.test:8080",
};
const sanitized = nestedNpmEnvironment(source);
assert.equal(sanitized.PATH, source.PATH);
assert.equal(sanitized.npm_config_registry, source.npm_config_registry, "nested npm environment removed the configured registry");
assert.equal(sanitized.HTTPS_PROXY, source.HTTPS_PROXY, "nested npm environment removed the configured proxy");
for (const key of Object.keys(source).filter((value) => !["PATH", "npm_config_registry", "HTTPS_PROXY"].includes(value))) {
  assert.equal(Object.hasOwn(sanitized, key), false, `nested npm environment retained ${key}`);
}
assert.equal(source.npm_config_dry_run, "true", "nested npm environment mutated its caller");
assert.throws(() => nestedNpmEnvironment(null), /environment record/);

let prefixInvocation = null;
const globalPrefix = resolveNpmGlobalPrefix("/synthetic/npm-cli.js", {
  cwd: "/synthetic/workspace",
  env: {
    PATH: "/example/bin",
    NPM_CONFIG_PREFIX: "/contaminated/prefix",
    NPM_CONFIG_WORKSPACES: "true",
  },
  run(command, args, options) {
    prefixInvocation = { command, args, options };
    return { status: 0, stdout: "/configured/global-prefix\n", stderr: "" };
  },
});
assert.equal(globalPrefix, "/configured/global-prefix");
assert.deepEqual(prefixInvocation.args, [
  "/synthetic/npm-cli.js", "prefix", "--global", "--json=false", "--parseable=false",
]);
assert.equal(Object.hasOwn(prefixInvocation.options.env, "NPM_CONFIG_PREFIX"), false);
assert.equal(Object.hasOwn(prefixInvocation.options.env, "NPM_CONFIG_WORKSPACES"), false);
assert.throws(() => resolveNpmGlobalPrefix("relative/npm-cli.js"), /absolute npm CLI path/);
const privatePath = [process.env.HOME || "/home/synthetic", "private-prefix"].join("/");
const credentialUrl = ["https://", "synthetic-user", ":", "synthetic-password", "@registry.example.invalid"].join("");
assert.throws(() => resolveNpmGlobalPrefix("/synthetic/npm-cli.js", {
  run: () => ({ status: 1, stdout: "", stderr: `${credentialUrl} ${privatePath}` }),
}), error => {
  const message = String(error?.message || error);
  assert(!message.includes("synthetic-password") && !message.includes(privatePath));
  return /npm prefix failed/.test(message);
});
assert.throws(() => resolveNpmGlobalPrefix("/synthetic/npm-cli.js", {
  run: () => ({ status: 0, stdout: "relative-prefix\n", stderr: "" }),
}), /output is invalid/);

console.log("nested npm environment sanitation test ok");
