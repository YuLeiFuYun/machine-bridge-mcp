import type { ValidatedAuthorization } from "./state.ts";
import { escapeHtml, html, normalizeDisplayText, searchParamsEntries } from "../room/http.ts";

const AUTHORIZATION_FIELDS = new Set([
  "response_type", "client_id", "redirect_uri", "code_challenge",
  "code_challenge_method", "scope", "resource", "state",
]);

export interface AuthorizationPageOptions {
  request: Request;
  base: string;
  serverName: string;
  error?: string;
  submitted?: Record<string, unknown>;
  status?: number;
  authorization?: ValidatedAuthorization;
  allowSubmit?: boolean;
}

export function authorizationPage({
  request,
  base,
  serverName,
  error = "",
  submitted,
  status = 200,
  authorization,
  allowSubmit = true,
}: AuthorizationPageOptions): Response {
  const url = new URL(request.url);
  const sourceEntries = submitted ? Object.entries(submitted) : searchParamsEntries(url.searchParams);
  const hidden = sourceEntries
    .filter(([key]) => AUTHORIZATION_FIELDS.has(key))
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
    .join("\n");
  const resource = normalizeDisplayText(
    authorization?.requestedResource ?? String(submitted?.resource ?? url.searchParams.get("resource") ?? `${base}/mcp`),
    1024,
    `${base}/mcp`,
  );
  const clientBlock = authorization
    ? `<p><strong>Client:</strong> ${escapeHtml(authorization.client.client_name)}</p>
    <p><strong>Redirect URI:</strong> <code>${escapeHtml(authorization.redirectUri)}</code></p>
    ${clientTrustNotice(authorization)}
    ${loopbackRedirectWarning(authorization.redirectUri)}`
    : "";
  const errorBlock = error ? `<p role="alert" aria-live="assertive" style="color:#b91c1c; font-weight:600">${escapeHtml(error)}</p>` : "";
  const accountName = normalizeDisplayText(String(submitted?.account_name ?? ""), 64, "");
  const form = allowSubmit
    ? `<form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Account name<br><input name="account_name" value="${escapeHtml(accountName)}" autocomplete="username" autofocus required style="width: 100%; box-sizing: border-box; padding: 8px;"></label>
      <p><label>Account password<br><input name="account_password" type="password" autocomplete="current-password" required style="width: 100%; box-sizing: border-box; padding: 8px;"></label></p>
      <p><button type="submit">Authorize</button></p>
    </form>`
    : "<p>Authorization cannot continue. Return to the MCP client and start the connection again.</p>";
  const escapedServer = escapeHtml(normalizeDisplayText(serverName, 128, "Machine Bridge"));
  return html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${escapedServer}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorize ${escapedServer}</h1>
    <p>Only continue if you initiated this MCP connection and recognize the client and redirect URI below.</p>
    ${clientBlock}
    <p><strong>Resource:</strong> <code>${escapeHtml(resource)}</code></p>
    ${errorBlock}
    ${form}
  </body>
</html>`, status);
}

export function authorizationRedirectPage({
  location,
  clientName,
  serverName,
}: {
  location: URL;
  clientName: string;
  serverName: string;
}): Response {
  if (location.protocol !== "https:" && location.protocol !== "http:") {
    throw new Error("OAuth authorization redirect target must use HTTPS or HTTP");
  }
  const escapedHref = escapeHtml(location.href);
  const escapedClient = escapeHtml(normalizeDisplayText(clientName, 128, "client"));
  const escapedServer = escapeHtml(normalizeDisplayText(serverName, 128, "Machine Bridge"));
  return new Response(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="refresh" content="0;url=${escapedHref}">
    <title>Returning to ${escapedClient}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorization complete</h1>
    <p>Returning from ${escapedServer} to <strong>${escapedClient}</strong>...</p>
    <p><a href="${escapedHref}" rel="noreferrer">Continue to ${escapedClient}</a></p>
  </body>
</html>`, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function clientTrustNotice(authorization: ValidatedAuthorization): string {
  const previouslyAuthorized = authorization.client.has_been_authorized === true
    && Boolean(authorization.client.trusted_account_id);
  return previouslyAuthorized
    ? `<p><strong>Client status:</strong> Previously authorized and account-bound on this Machine Bridge.</p>`
    : `<p role="alert"><strong>Client status:</strong> Unverified dynamically registered client. The client name is self-asserted; verify the redirect URI before entering credentials.</p>`;
}

function loopbackRedirectWarning(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return "";
    return `<p role="alert"><strong>Local callback:</strong> This authorization code will be sent to a loopback address on this device. Continue only if you initiated the local client connection.</p>`;
  } catch {
    return "";
  }
}
