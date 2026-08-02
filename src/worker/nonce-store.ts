interface NonceStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface TransactionalNonceStorage extends NonceStorage {
  transaction<T>(callback: (transaction: NonceStorage) => Promise<T>): Promise<T>;
}

export async function consumeBoundedNonce(
  storage: DurableObjectStorage | NonceStorage,
  options: {
    key: string;
    nonce: string;
    expiresAt: number;
    now: number;
    noncePattern: RegExp;
    maximum: number;
  },
): Promise<boolean> {
  validateOptions(options);
  const consume = (target: NonceStorage) => consumeInStorage(target, options);
  if (hasTransactions(storage)) return storage.transaction(consume);
  return consume(storage);
}

export async function boundedNoncePresent(
  storage: Pick<NonceStorage, "get">,
  options: {
    key: string;
    nonce: string;
    now: number;
    noncePattern: RegExp;
  },
): Promise<boolean> {
  if (!/^[a-z][a-z0-9-]{1,127}$/.test(options.key)
      || !options.noncePattern.test(options.nonce)
      || !Number.isSafeInteger(options.now) || options.now <= 0) return false;
  const raw = await storage.get<unknown>(options.key);
  if (!validNonceRecord(raw, options.noncePattern)) return false;
  return Number((raw as Record<string, number>)[options.nonce] ?? 0) > options.now;
}

async function consumeInStorage(
  storage: NonceStorage,
  options: {
    key: string;
    nonce: string;
    expiresAt: number;
    now: number;
    noncePattern: RegExp;
    maximum: number;
  },
): Promise<boolean> {
  const raw = await storage.get<unknown>(options.key);
  if (raw !== undefined && !validNonceRecord(raw, options.noncePattern)) return false;
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

function validateOptions(options: {
  key: string;
  nonce: string;
  expiresAt: number;
  now: number;
  noncePattern: RegExp;
  maximum: number;
}): void {
  if (!/^[a-z][a-z0-9-]{1,127}$/.test(options.key)) throw new Error("nonce-store key is invalid");
  if (!options.noncePattern.test(options.nonce)) throw new Error("nonce-store nonce is invalid");
  if (!Number.isSafeInteger(options.now) || options.now <= 0) throw new Error("nonce-store current time is invalid");
  if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= options.now) throw new Error("nonce-store expiration is invalid");
  if (!Number.isSafeInteger(options.maximum) || options.maximum < 1 || options.maximum > 4096) throw new Error("nonce-store maximum is invalid");
}

function validNonceRecord(value: unknown, noncePattern: RegExp): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([nonce, expiresAt]) => (
    noncePattern.test(nonce) && Number.isSafeInteger(expiresAt) && expiresAt > 0
  ));
}

function hasTransactions(storage: DurableObjectStorage | NonceStorage): storage is TransactionalNonceStorage {
  return typeof (storage as Partial<TransactionalNonceStorage>).transaction === "function";
}
