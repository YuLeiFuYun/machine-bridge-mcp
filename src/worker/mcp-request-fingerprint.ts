export async function workerToolRequestFingerprint(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const canonical = canonicalJson({ tool, arguments: args });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("tool arguments exceed canonicalization depth");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("tool arguments contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("tool arguments contain an unsupported value");
}
