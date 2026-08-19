import { classifyRelayTransportError, terminateSocket } from "./relay-connection-support.mjs";
import { preferredRelayCloseCategory } from "./relay-diagnostics.mjs";
import { classifyOperationalError } from "./log.mjs";

export function relayLivenessActions(connection) {
  return {
    onTransportError: (error, socket) => {
      const errorClass = connection.transportError.record(classifyRelayTransportError(error), {
        error, ready: connection.ready, authenticated: connection.authenticated,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory, "relay_transport_error");
      connection.logger.debug?.("remote relay transport ping failed", { error_class: errorClass });
      terminateSocket(socket);
    },
    onTransportSuspect: ({ silentForMs, probeAgeMs, confirmation_timeout_ms: confirmationTimeoutMs }, socket) => {
      if (!socket || !connection.ready) return;
      connection.logger.warn?.("remote relay protocol pong overdue; checking the application path before reconnecting", {
        event: "relay.transport.suspect", silent_for_ms: silentForMs,
        probe_age_ms: bounded(probeAgeMs), confirmation_timeout_ms: bounded(confirmationTimeoutMs),
      });
      notifyObserver(connection, "onDegraded", {
        category: "relay_transport_timeout", connectionId: connection.workerConnectionId, sessionId: connection.activeSessionId,
      }, "relay degraded callback failed");
    },
    onTransportRecovered: ({ confirmation_ms: confirmationMs, reason = "inbound_confirmation", confirmed = true }, socket) => {
      if (!socket || !connection.ready) return;
      connection.logger.warn?.("remote relay transport suspicion cleared without reconnecting", {
        event: "relay.transport.recovered", confirmation_ms: bounded(confirmationMs),
        recovery_reason: reason, transport_confirmed: confirmed === true,
      });
      notifyObserver(connection, "onRecovered", {
        category: "relay_transport_timeout", connectionId: connection.workerConnectionId, sessionId: connection.activeSessionId,
      }, "relay recovery callback failed");
    },
    onTransportTimeout: ({ silentForMs, eventLoopLagMs, probeAgeMs, dispatchAgeMs,
      confirmationDispatchAgeMs, confirmationAgeMs }, socket) => {
      if (!socket) return;
      const dispatchTimedOut = Number(dispatchAgeMs) > 0 || Number(confirmationDispatchAgeMs) > 0;
      const confirmationSendTimedOut = Number(confirmationDispatchAgeMs) > 0;
      connection.logger.warn?.(dispatchTimedOut ? "remote relay liveness frame dispatch timed out" : "remote relay transport confirmation failed; reconnecting", {
        event: confirmationSendTimedOut ? "relay.transport.confirmation_send_timeout"
          : dispatchTimedOut ? "relay.transport.send_timeout" : "relay.transport.confirmation_failed",
        silent_for_ms: silentForMs, probe_age_ms: bounded(probeAgeMs), dispatch_age_ms: bounded(dispatchAgeMs),
        confirmation_dispatch_age_ms: bounded(confirmationDispatchAgeMs),
        confirmation_age_ms: bounded(confirmationAgeMs), event_loop_lag_ms: eventLoopLagMs,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory,
        dispatchTimedOut ? "relay_transport_send_timeout" : "relay_transport_timeout");
      terminateSocket(socket);
    },
    onApplicationTimeout: ({ silentForMs, eventLoopLagMs }, socket) => {
      if (!socket) return;
      connection.logger.debug?.("remote relay application heartbeat timed out", {
        silent_for_ms: silentForMs, event_loop_lag_ms: eventLoopLagMs,
      });
      connection.pendingCloseCategory = preferredRelayCloseCategory(connection.pendingCloseCategory, "relay_heartbeat_timeout");
      terminateSocket(socket);
    },
  };
}

function bounded(value) { return Math.max(0, Number(value) || 0); }
function notifyObserver(connection, name, event, message) {
  try { connection[name](event); }
  catch (error) { connection.logger.error?.(message, { error_class: classifyOperationalError(error) }); }
}
