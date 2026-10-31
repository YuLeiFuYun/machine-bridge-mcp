const ACCOUNT_ID = `acct_${"t".repeat(32)}`;
const CLIENT_ID = `mcp_client_${"t".repeat(43)}`;
const FAMILY_ID = `mcp_family_${"t".repeat(43)}`;

export function accountPrincipal(overrides = {}) {
  return Object.freeze({
    kind: "account",
    accountId: ACCOUNT_ID,
    accountVersion: 1,
    clientId: CLIENT_ID,
    familyId: FAMILY_ID,
    role: "owner",
    ...overrides,
  });
}

export function relayOwnerContext(overrides = {}) {
  return {
    origin: "relay",
    authority: {
      origin: "relay",
      owner: true,
      principal: accountPrincipal(),
    },
    ...overrides,
  };
}

export function relayDelegatedContext(overrides = {}) {
  return {
    origin: "relay",
    authority: {
      origin: "relay",
      owner: false,
      principal: accountPrincipal({ role: "reviewer" }),
    },
    ...overrides,
  };
}
