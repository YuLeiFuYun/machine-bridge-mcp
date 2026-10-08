import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;
const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;
const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export function bindCallPrincipal(record, principal) {
  if (!record || !principal || typeof principal !== "object") return false;
  if (principal.kind === "local") {
    record.owner_kind = "local";
    return true;
  }
  if (principal.kind !== "account") return false;
  if (typeof principal.accountId !== "string" || !ACCOUNT_ID.test(principal.accountId)
      || !Number.isSafeInteger(principal.accountVersion) || principal.accountVersion <= 0
      || typeof principal.clientId !== "string" || !CLIENT_ID.test(principal.clientId)
      || typeof principal.familyId !== "string" || !FAMILY_ID.test(principal.familyId)) return false;
  record.owner_kind = "account";
  record.owner_account_id = principal.accountId;
  record.owner_account_version = principal.accountVersion;
  record.owner_client_id = principal.clientId;
  record.owner_family_id = principal.familyId;
  return true;
}

export function callIdsForAuthority(records, revocation) {
  return [...records]
    .filter((record) => recordMatchesAuthorityRevocation(record, revocation))
    .map((record) => record.id);
}
