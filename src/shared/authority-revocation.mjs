const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;
const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;
const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export function normalizeAuthorityRevocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accountId = String(value.account_id || "");
  const accountVersion = Number(value.account_version);
  const clientId = value.client_id === undefined ? "" : String(value.client_id || "");
  const familyId = value.family_id === undefined ? "" : String(value.family_id || "");
  if (!ACCOUNT_ID.test(accountId) || !Number.isSafeInteger(accountVersion) || accountVersion <= 0) return null;
  if (clientId && !CLIENT_ID.test(clientId)) return null;
  if (familyId && (!clientId || !FAMILY_ID.test(familyId))) return null;
  return Object.freeze({
    accountId,
    accountVersion,
    ...(clientId ? { clientId } : {}),
    ...(familyId ? { familyId } : {}),
  });
}

export function recordMatchesAuthorityRevocation(record, revocation) {
  if (!record || !revocation || record.owner_kind !== "account") return false;
  if (record.owner_account_id !== revocation.accountId || record.owner_account_version !== revocation.accountVersion) return false;
  if (revocation.clientId && record.owner_client_id !== revocation.clientId) return false;
  if (revocation.familyId && record.owner_family_id !== revocation.familyId) return false;
  return true;
}
