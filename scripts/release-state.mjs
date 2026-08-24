export function tagSyncError({ scope = "local", tag, head, commit }) {
  const label = scope === "remote" ? "remote tag" : "local tag";
  if (!commit) {
    return `${label} ${tag} is missing; run the applicable GitHub release command before npm publish`;
  }
  if (commit !== head) {
    return `${label} ${tag} points to ${commit}, not HEAD ${head}`;
  }
  return "";
}
