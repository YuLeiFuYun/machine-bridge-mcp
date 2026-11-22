/**
 * Zero-dependency PBKDF2-HMAC-SHA256 fallback used solely to verify pre-existing
 * legacy account records stored with >100,000 iterations on Hosted Cloudflare Workers
 * where WebCrypto PBKDF2 caps at 100,000 iterations. New and migrated hashes use
 * 100,000 iterations via native WebCrypto.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function sha256Compress(state: Uint32Array, block: Uint8Array, w: Uint32Array): void {
  for (let i = 0; i < 16; i += 1) {
    const o = i * 4;
    w[i] = ((block[o]! << 24) | (block[o + 1]! << 16) | (block[o + 2]! << 8) | block[o + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i += 1) {
    const s0 = ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^ ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^ (w[i - 15]! >>> 3);
    const s1 = ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^ ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^ (w[i - 2]! >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
  for (let i = 0; i < 64; i += 1) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ ((~e) & g);
    const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0; state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
}

function sha256Block(data: Uint8Array): Uint8Array {
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[data.length] = 0x80;
  const bitLen = data.length * 8;
  buf[paddedLen - 4] = (bitLen >>> 24) & 0xff; buf[paddedLen - 3] = (bitLen >>> 16) & 0xff;
  buf[paddedLen - 2] = (bitLen >>> 8) & 0xff; buf[paddedLen - 1] = bitLen & 0xff;
  const state = new Uint32Array(SHA256_IV);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    sha256Compress(state, buf.subarray(offset, offset + 64), w);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const v = state[i]!;
    out[i * 4] = (v >>> 24) & 0xff; out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff; out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

export function legacyPbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, dkLen = 32): Uint8Array {
  const key = password.length > 64 ? sha256Block(password) : password;
  const ipadState = new Uint32Array(SHA256_IV);
  const opadState = new Uint32Array(SHA256_IV);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const b = i < key.length ? key[i]! : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const w = new Uint32Array(64);
  sha256Compress(ipadState, ipad, w);
  sha256Compress(opadState, opad, w);

  const innerBlock = new Uint8Array(64);
  innerBlock[32] = 0x80; innerBlock[62] = 0x03; innerBlock[63] = 0x00; // 64 + 32 bytes = 96*8 = 768 = 0x0300 bits
  const outerBlock = new Uint8Array(64);
  outerBlock[32] = 0x80; outerBlock[62] = 0x03; outerBlock[63] = 0x00;
  const st = new Uint32Array(8);
  const stateToBlock = (s: Uint32Array, dst: Uint8Array) => {
    for (let i = 0; i < 8; i += 1) {
      const v = s[i]!;
      dst[i * 4] = (v >>> 24) & 0xff; dst[i * 4 + 1] = (v >>> 16) & 0xff;
      dst[i * 4 + 2] = (v >>> 8) & 0xff; dst[i * 4 + 3] = v & 0xff;
    }
  };
  const hmacPrecomputed = (msg32: Uint8Array, dst: Uint8Array) => {
    innerBlock.set(msg32);
    st.set(ipadState);
    sha256Compress(st, innerBlock, w);
    stateToBlock(st, outerBlock);
    st.set(opadState);
    sha256Compress(st, outerBlock, w);
    stateToBlock(st, dst);
  };

  const out = new Uint8Array(dkLen);
  const blocks = Math.ceil(dkLen / 32);
  const u = new Uint8Array(32);
  const t = new Uint8Array(32);
  for (let blockIndex = 1; blockIndex <= blocks; blockIndex += 1) {
    const initial = new Uint8Array(64 + salt.length + 4);
    initial.set(ipad, 0);
    initial.set(salt, 64);
    initial[64 + salt.length] = (blockIndex >>> 24) & 0xff;
    initial[64 + salt.length + 1] = (blockIndex >>> 16) & 0xff;
    initial[64 + salt.length + 2] = (blockIndex >>> 8) & 0xff;
    initial[64 + salt.length + 3] = blockIndex & 0xff;
    const innerHash = sha256Block(initial);
    st.set(opadState);
    outerBlock.set(innerHash);
    sha256Compress(st, outerBlock, w);
    stateToBlock(st, u);
    t.set(u);
    for (let iter = 1; iter < iterations; iter += 1) {
      hmacPrecomputed(u, u);
      for (let j = 0; j < 32; j += 1) t[j] = t[j]! ^ u[j]!;
    }
    const copyLen = Math.min(32, dkLen - (blockIndex - 1) * 32);
    out.set(t.subarray(0, copyLen), (blockIndex - 1) * 32);
  }
  return out;
}
