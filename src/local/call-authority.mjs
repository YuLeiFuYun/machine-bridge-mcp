import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";

export function bindCallPrincipal(record, principal) {
  if (!record || !principal || typeof principal !== "object") return false;
  if (principal.kind !== "account") {
    record.owner_kind = "local";
    return true;
  }
  record.owner_kind = "account";
  record.owner_account_id = String(principal.accountId || "");
  record.owner_account_version = Number(principal.accountVersion);
  record.owner_client_id = String(principal.clientId || "");
  record.owner_family_id = String(principal.familyId || "");
  return true;
}

export function callIdsForAuthority(records, revocation) {
  return [...records]
    .filter((record) => recordMatchesAuthorityRevocation(record, revocation))
    .map((record) => record.id);
}
