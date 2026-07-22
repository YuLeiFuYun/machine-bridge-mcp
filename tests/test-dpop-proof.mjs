import { webcrypto } from "node:crypto";
import { normalizedHtu } from "../src/worker/dpop.ts";

export async function createDpopFixture() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    privateJwk: await webcrypto.subtle.exportKey("jwk", keys.privateKey),
    publicJwk: await webcrypto.subtle.exportKey("jwk", keys.publicKey),
  };
}

export async function createDpopProof({ privateJwk, publicJwk, method, url, issuedAt, jti, accessToken = "" }) {
  const header = encode(Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })));
  const payload = {
    htm: String(method).toUpperCase(),
    htu: normalizedHtu(url),
    iat: issuedAt,
    jti,
    ...(accessToken ? { ath: await sha256Base64Url(accessToken) } : {}),
  };
  const encodedPayload = encode(Buffer.from(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${header}.${encodedPayload}`));
  return `${header}.${encodedPayload}.${encode(Buffer.from(signature))}`;
}

async function sha256Base64Url(value) {
  return encode(Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(value))));
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}
