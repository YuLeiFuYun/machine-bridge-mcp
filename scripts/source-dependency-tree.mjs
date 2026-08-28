import { resolve } from "node:path";

export const sourceDependencyTreeInstallTimeoutMs = 20 * 60 * 1000;

export function sourceDependencyTreeInstallArguments(repositoryRoot) {
  const value = String(repositoryRoot || "").trim();
  if (!value) throw new TypeError("source dependency installation requires a repository root");
  const root = resolve(value);
  return [
    "ci",
    "--dry-run=false",
    "--workspaces=false",
    "--global=false",
    "--ignore-scripts=false",
    "--package-lock-only=false",
    "--audit=false",
    "--fund=false",
    "--logs-max=0",
    "--prefix", root,
  ];
}
