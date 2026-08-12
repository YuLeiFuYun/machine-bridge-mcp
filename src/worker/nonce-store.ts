interface NonceStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface TransactionalNonceStorage extends NonceStorage {
  transaction<T>(callback: (transaction: NonceStorage) => Promise<T>): Promise<T>;
}

interface NonceOptions {
  key: string;
  nonce: string;
  expiresAt: number;
  now: number;
  noncePattern: RegExp;
  maximum: number;
  maxFutureSeconds: number;
}

export async function consumeBoundedNonce(
  storage: DurableObjectStorage | NonceStorage,
  options: NonceOptions,
): Promise<boolean> {
  validateOptions(options);
  const consume = (target: NonceStorage) => consumeInStorage(target, options);
  if (hasTransactions(storage)) return storage.transaction(consume);
  return consume(storage);
}

async function consumeInStorage(
  storage: NonceStorage,
  options: NonceOptions,
): Promise<boolean> {
  const raw = await storage.get<unknown>(options.key);
  if (raw !== undefined
      && !validNonceRecord(raw, options.noncePattern, options.maximum, options.now + options.maxFutureSeconds)) return false;
  const nonces: Record<string, number> = raw ? { ...raw as Record<string, number> } : {};
  for (const [nonce, expiresAt] of Object.entries(nonces)) {
    if (expiresAt <= options.now) delete nonces[nonce];
  }
  if (nonces[options.nonce]) return false;
  if (Object.keys(nonces).length >= options.maximum) return false;
  nonces[options.nonce] = options.expiresAt;
  await storage.put(options.key, nonces);
  return true;
}

function validateOptions(options: NonceOptions): void {
  if (!/^[a-z][a-z0-9-]{1,127}$/.test(options.key)) throw new Error("nonce-store key is invalid");
  if (!options.noncePattern.test(options.nonce)) throw new Error("nonce-store nonce is invalid");
  if (!Number.isSafeInteger(options.now) || options.now <= 0) throw new Error("nonce-store current time is invalid");
  if (!Number.isSafeInteger(options.maximum) || options.maximum < 1 || options.maximum > 4096) throw new Error("nonce-store maximum is invalid");
  const latestExpiry = options.now + options.maxFutureSeconds;
  if (!Number.isSafeInteger(options.maxFutureSeconds) || options.maxFutureSeconds < 1 || !Number.isSafeInteger(latestExpiry)) {
    throw new Error("nonce-store future window is invalid");
  }
  if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= options.now || options.expiresAt > latestExpiry) {
    throw new Error("nonce-store expiration is invalid");
  }
}

function validNonceRecord(value: unknown, noncePattern: RegExp, maximum: number, latestExpiry: number): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let count = 0;
  for (const nonce in value) {
    if (!Object.hasOwn(value, nonce)) continue;
    count += 1;
    if (count > maximum) return false;
    const expiresAt = (value as Record<string, unknown>)[nonce];
    if (!noncePattern.test(nonce) || !Number.isSafeInteger(expiresAt) || Number(expiresAt) <= 0 || Number(expiresAt) > latestExpiry) return false;
  }
  return true;
}

function hasTransactions(storage: DurableObjectStorage | NonceStorage): storage is TransactionalNonceStorage {
  return typeof (storage as Partial<TransactionalNonceStorage>).transaction === "function";
}
