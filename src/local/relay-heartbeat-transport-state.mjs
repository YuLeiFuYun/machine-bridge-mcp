export function advanceRelayTransportState(monitor, now, silentForMs, eventLoopLagMs) {
  if (monitor.confirmation.pending()) {
    if (monitor.confirmation.dispatchExpired(now)) {
      monitor.onTimeout({ silentForMs, eventLoopLagMs,
        confirmationDispatchAgeMs: monitor.confirmation.dispatchTimeout(now) });
    } else if (monitor.confirmation.expired(now)) {
      monitor.onTimeout({ silentForMs, eventLoopLagMs, confirmationAgeMs: monitor.confirmation.timeout(now) });
    }
    return true;
  }
  if (!monitor.probeDeadline.enabled) return false;
  if (monitor.probeDispatch.pending()) {
    const dispatchAgeMs = monitor.probeDispatch.age(now);
    if (dispatchAgeMs >= monitor.dispatchTimeoutMs) {
      monitor.probeDispatch.timeout(now);
      monitor.onTimeout({ silentForMs, eventLoopLagMs, probeAgeMs: 0, dispatchAgeMs });
    }
    return true;
  }
  if (monitor.probeDeadline.outstanding()) {
    const probeAgeMs = monitor.probeDeadline.age(now);
    if (probeAgeMs >= monitor.timeoutMs) {
      const details = { silentForMs, eventLoopLagMs, probeAgeMs: monitor.probeDeadline.timeout(now) };
      if (!monitor.confirmation.begin(now, details)) monitor.onTimeout(details);
    }
    return true;
  }
  monitor.sendProbe(now);
  return true;
}
