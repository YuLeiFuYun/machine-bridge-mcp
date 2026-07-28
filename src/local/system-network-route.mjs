// @ts-check

const TUNNEL_INTERFACE = /^(?:utun|tun|tap|ppp|ipsec|wg|gif|stf)/i;
const LOOPBACK_INTERFACE = /^lo\d*$/i;
const PHYSICAL_INTERFACE = /^(?:en|eth|wlan|wl|wifi|wi-fi)\d*$/i;

/** @typedef {{code?: number, stdout?: string}} FixedProcessResult */
/** @typedef {(command: string, args: string[], timeoutMs: number, capture: boolean, maxOutputBytes: number, context: unknown) => Promise<FixedProcessResult>} FixedInternalRunner */
/**
 * @typedef {{
 *   platform?: string,
 *   runFixedInternal?: FixedInternalRunner,
 *   classifyError?: (error: unknown) => string,
 *   context?: unknown,
 * }} SystemNetworkRouteOptions
 */

/** @param {SystemNetworkRouteOptions} [options] */
export async function systemNetworkRouteCheck({
  platform = process.platform,
  runFixedInternal,
  classifyError = () => "unavailable",
  context = {},
} = {}) {
  try {
    const route = await inspectSystemNetworkRoute({ platform, runFixedInternal, context });
    return route.supported && route.available ? {
      layer: "system-network-route",
      ok: true,
      route_class: route.route_class,
      operating_system_interception: route.operating_system_interception === true,
    } : {
      layer: "system-network-route",
      ok: false,
      skipped: true,
      error_class: route.supported ? "unavailable" : "unsupported_platform",
    };
  } catch (error) {
    return {
      layer: "system-network-route",
      ok: false,
      skipped: true,
      error_class: classifyError(error),
    };
  }
}

/** @param {SystemNetworkRouteOptions} [options] */
export async function inspectSystemNetworkRoute({
  platform = process.platform,
  runFixedInternal,
  context = {},
} = {}) {
  if (platform !== "darwin" || typeof runFixedInternal !== "function") return { supported: false };
  const result = await runFixedInternal("/sbin/route", ["-n", "get", "default"], 5_000, true, 16 * 1024, context);
  if (result?.code !== 0) return { supported: true, available: false };
  const match = String(result.stdout || "").match(/^\s*interface:\s*(\S+)\s*$/mi);
  if (!match) return { supported: true, available: false };
  const routeClass = classifySystemRouteInterface(match[1]);
  return {
    supported: true,
    available: true,
    route_class: routeClass,
    operating_system_interception: routeClass === "tunnel-or-vpn",
  };
}

/** @param {unknown} value */
export function classifySystemRouteInterface(value) {
  const name = String(value || "").trim();
  if (!name) return "unknown";
  if (TUNNEL_INTERFACE.test(name)) return "tunnel-or-vpn";
  if (LOOPBACK_INTERFACE.test(name)) return "loopback";
  if (PHYSICAL_INTERFACE.test(name)) return "physical-or-other";
  return "other";
}
