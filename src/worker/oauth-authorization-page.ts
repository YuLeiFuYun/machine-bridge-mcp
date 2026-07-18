import type { ValidatedAuthorization } from "./oauth-state.ts";
import {
  escapeHtml, html, normalizeDisplayText, searchParamsEntries,
} from "./http.ts";

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
    <p><strong>Redirect URI:</strong> <code>${escapeHtml(authorization.redirectUri)}</code></p>`
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
  const redirectOrigin = authorization ? new URL(authorization.redirectUri).origin : "";
  return html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${serverName}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.5; padding: 0 16px;">
    <h1>Authorize ${serverName}</h1>
    <p>Only continue if you initiated this MCP connection and recognize the client and redirect URI below.</p>
    ${clientBlock}
    <p><strong>Resource:</strong> <code>${escapeHtml(resource)}</code></p>
    ${errorBlock}
    ${form}
  </body>
</html>`, status, redirectOrigin);
}
