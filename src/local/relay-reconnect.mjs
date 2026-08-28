export function scheduleRelayReconnectBackoffReset(state, socket, sessionId) {
  state.clearTimer("reconnectStabilityTimer", "clearTimeout");
  if (state.reconnectAttempt <= 0) return;
  state.reconnectStabilityTimer = state.scheduler.setTimeout(() => {
    state.reconnectStabilityTimer = null;
    if (state.closed || state.socket !== socket || !state.ready || state.activeSessionId !== sessionId) return;
    state.reconnectAttempt = 0;
  }, state.reconnectStableReadyMs);
  state.reconnectStabilityTimer?.unref?.();
}

export function settleRelayReconnectBackoffOnClose(state, wasReady, readyDurationMs) {
  state.clearTimer("reconnectStabilityTimer", "clearTimeout");
  if (wasReady && Number(readyDurationMs) >= state.reconnectStableReadyMs) state.reconnectAttempt = 0;
}

export function scheduleRelayReconnect(state, category) {
  if (state.closed || state.reconnectTimer) return;
  state.recordOutage(category);
  const delay = state.reconnectDelay(state.reconnectAttempt++, Math.random, state.connectTiming.durationMs, state.connectTimeoutMs);
  state.lastReconnectDelayMs = delay;
  state.nextReconnectAt = state.now() + delay;
  state.nextReconnectWallAt = state.wallNow() + delay;
  state.scheduleOutageWarning();
  state.logger.debug?.("scheduling daemon reconnect", {
    delay_ms: delay,
    next_reconnect_at: new Date(state.nextReconnectWallAt).toISOString(),
    attempt: state.outageAttempts,
    close_category: state.lastCloseCategory,
    network_route: state.networkRoute,
    network_route_scope: state.networkRouteScope,
  });
  state.reconnectTimer = state.scheduler.setTimeout(() => {
    state.reconnectTimer = null;
    state.nextReconnectAt = 0;
    state.nextReconnectWallAt = 0;
    state.connect();
  }, delay);
  state.reconnectTimer?.unref?.();
}
