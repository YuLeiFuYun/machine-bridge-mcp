const DERIVATION_DOMAIN = "machine-bridge-mcp/oauth-refresh-replacement/v1";

export async function deriveRefreshReplacementPair(
  keyMaterial: string,
  consumedRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (!keyMaterial) throw new Error("OAuth token derivation key is not configured");
  if (!/^mcp_rt_[A-Za-z0-9_-]{43}$/.test(consumedRefreshToken)) {
    throw new Error("refresh replacement seed is invalid");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [accessDigest, refreshDigest] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(`${DERIVATION_DOMAIN}\0access\0${consumedRefreshToken}`)),
    crypto.subtle.sign("HMAC", key, encoder.encode(`${DERIVATION_DOMAIN}\0refresh\0${consumedRefreshToken}`)),
  ]);
  return {
    accessToken: `mcp_at_${base64Url(new Uint8Array(accessDigest))}`,
    refreshToken: `mcp_rt_${base64Url(new Uint8Array(refreshDigest))}`,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
