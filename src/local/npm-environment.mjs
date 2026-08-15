const NESTED_NPM_MODE_KEYS = new Set([
  "npm_config_global_style",
  "npm_config_install_strategy",
  "npm_config_strict_peer_deps",
  "npm_config_legacy_peer_deps",
  "npm_config_force",
  "npm_config_shrinkwrap",
  "npm_config_package_lock",
  "npm_config_parseable",
  "npm_config_json",
  "npm_config_if_present",
  "npm_config_dry_run",
  "npm_config_global",
  "npm_config_prefix",
  "npm_config_workspace",
  "npm_config_workspaces",
  "npm_config_ignore_scripts",
  "npm_config_package_lock_only",
  "npm_config_omit",
  "npm_config_include",
  "npm_config_production",
  "npm_config_save",
  "npm_config_save_dev",
  "npm_config_save_optional",
  "npm_config_save_peer",
]);

export function nestedNpmEnvironment(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("nested npm environment must be an environment record");
  }
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (NESTED_NPM_MODE_KEYS.has(key.toLowerCase())) delete result[key];
  }
  return result;
}
