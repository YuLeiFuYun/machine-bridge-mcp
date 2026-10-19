# Changelog

## 3.0.0-beta.205 - 2026-10-19

- Supersede beta.203 after its Windows atomic-replacement and macOS resource CLI checks failed, and beta.204 after review reproduced an external-generation overwrite during a replacement retry. Repeat exact-package activation and deployed OAuth acceptance for the new candidate.
- Revalidate the expected content digest before every atomic-replacement attempt so an external edit after a transient sharing failure returns a conflict and retains the external generation; regression coverage also verifies staging cleanup.
- Preserve an absent coverage environment variable in uninstrumented CLI test children so an exact-runtime version probe retains its light resource classification; assert the actual CLI environment before submission.

- Keep one bridge Durable Object per deployment. The `x-mbm-workspace` / `?workspace=` shard selector is removed: it had no producer, and an unauthenticated request header could fork OAuth clients, tokens, the daemon registry, and pending calls into a second consistency domain.
- Add an opt-in `--compat` stdio mode for legacy hosts that refuse to start without `initialize`. It accepts the removed handshake and `notifications/initialized` without creating a session, advertises the server's own protocol version instead of echoing the client's, and fills request metadata only when fields are absent; explicit retired, future, or malformed metadata remains subject to normal rejection. `client-config` no longer injects the flag, and `--help` documents it.
- Make `browser_screenshot.allow_tab_switch` reachable over MCP: the catalog now declares the option and the service parses it as a strict boolean, so non-disruptive capture can fail on an inactive target instead of activating it.
- Replace the `MBM_DEBUG`-driven verbose error projection with an explicit per-call option. `MBM_DEBUG` no longer widens tool error output, the stdio server opts in per process with `MBM_VERBOSE_ERRORS=1`, the relay never opts in, and verbose messages and causes share the single sanitized 2000-character ceiling of the public message field.
- Drop the placeholder Desktop Automation and Power Management abstraction classes; capability reporting is now a plain function over the platform.
- Align `cloudflare.config.ts`, `wrangler.config.ts`, and `wrangler.jsonc` on the documented deployment topology, and relax `devEngines.packageManager` to `warn` so older npm setups do not hard-fail initialization.
- Bound stdio response backlog and output-buffer copying; harden protected-path resolution, terminal-job evidence checks, file-transaction cleanup reporting, and default instruction-context payloads. Add regression tests for the associated security, settlement, and performance boundaries.
- Retry bounded transient filesystem sharing errors during atomic file replacement so concurrent Windows readers do not cause a premature update failure; preserve the original error after exhaustion and reject non-transient failures immediately.
- Repository hygiene: ignore the generated `.workflow/` directory and drop cached review artifacts and intermediate backups from the local workspace.


## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
