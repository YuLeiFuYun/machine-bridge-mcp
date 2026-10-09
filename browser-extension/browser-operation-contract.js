(() => {
  if (globalThis.__machineBridgeBrowserOperationContract) return;
  const MUTATING_METHODS = new Set([
    "manage_tabs", "point_action", "backend_node_action", "action", "fill_form", "upload_files", "screenshot",
  ]);
  const MUTATION_RESULT_SETTLEMENT_UNKNOWN = "browser mutation may have completed; the action outcome is unknown because its result could not be delivered. Inspect browser state before retrying.";
  function exactFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  function exactPositiveFiniteNumber(value) {
    const number = exactFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }
  function exactNormalizedCoordinate(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1
      ? (Object.is(value, -0) ? 0 : value) : null;
  }
  function exactPositiveInteger(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
  function exactNonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function exactBoolean(value, label, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean before dispatch`);
    return value;
  }
  function exactBoundedInteger(value, label, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }
  function exactImageFormat(value, label, fallback = "png") {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !["png", "jpeg"].includes(value)) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }
  function exactOptionalSha256(value, label) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid before dispatch`);
    return value.toLowerCase();
  }
  function exactOptionalText(value, label, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }
  function exactOptionalAuthorityString(value, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
      throw new Error("snapshot authority string is invalid before dispatch");
    }
    return value;
  }
  function requiredSnapshotAuthorityString(value, label, maxLength) {
    const text = exactOptionalAuthorityString(value, maxLength);
    if (!text) throw new Error(`${label} is required before dispatch`);
    return text;
  }
  function requiredSnapshotViewport(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("visual snapshot viewport is required before dispatch");
    const output = {};
    for (const key of ["width", "height", "scale"]) {
      const number = exactPositiveFiniteNumber(value[key]);
      if (number === null) throw new Error(`visual snapshot viewport ${key} is invalid before dispatch`);
      output[key] = number;
    }
    return output;
  }
  function methodMayMutate(method) { return typeof method === "string" && MUTATING_METHODS.has(method); }
  function responsePayload({ id, ok, result, error = "", method = "", maxBytes }) {
    const mutatingSuccess = ok === true && methodMayMutate(method);
    let payload;
    try { payload = JSON.stringify({ type: "response", id, ok, ...(ok ? { result } : { error }) }); }
    catch {
      payload = JSON.stringify({ type: "response", id, ok: false,
        error: mutatingSuccess ? MUTATION_RESULT_SETTLEMENT_UNKNOWN : "browser result could not be serialized" });
    }
    const resultLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    if (resultLimit === 0 || new TextEncoder().encode(payload).byteLength > resultLimit) {
      payload = JSON.stringify({ type: "response", id, ok: false,
        error: mutatingSuccess ? MUTATION_RESULT_SETTLEMENT_UNKNOWN : "browser result exceeds maximum size" });
    }
    return payload;
  }
  Object.defineProperty(globalThis, "__machineBridgeBrowserOperationContract", {
    value: Object.freeze({
      exactFiniteNumber, exactPositiveFiniteNumber, exactNormalizedCoordinate, exactPositiveInteger,
      exactNonNegativeInteger, exactBoolean, exactBoundedInteger, exactImageFormat, exactOptionalSha256,
      exactOptionalText, requiredSnapshotAuthorityString, requiredSnapshotViewport,
      exactOptionalAuthorityString, methodMayMutate, responsePayload,
    }),
    configurable: false,
  });
})();
