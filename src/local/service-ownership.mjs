export async function stopOwnedPlatformService({
  state,
  inspectWorkspaceDaemon,
  ownsPlatformAutostart,
  stopPlatformService,
} = {}) {
  if (!state) throw new TypeError("service ownership check requires state");
  if (typeof inspectWorkspaceDaemon !== "function") throw new TypeError("service ownership check requires inspectWorkspaceDaemon");
  if (typeof ownsPlatformAutostart !== "function") throw new TypeError("service ownership check requires ownsPlatformAutostart");
  if (typeof stopPlatformService !== "function") throw new TypeError("service ownership check requires stopPlatformService");
  const daemon = inspectWorkspaceDaemon(state);
  if (!ownsPlatformAutostart(daemon)) {
    return { owned: false, stopped: false, daemon, provider: null };
  }
  const provider = await stopPlatformService();
  return { owned: true, stopped: provider?.ok !== false, daemon, provider };
}
