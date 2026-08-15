# Local application and browser automation

Machine Bridge exposes two structured local-automation backends under the canonical `full` profile:

1. operating-system application discovery and macOS Accessibility actions;
2. a Chromium extension connected to a loopback broker for the user's existing browser profile, windows, tabs, cookies, and login state.

Neither backend accepts arbitrary caller-supplied AppleScript, JavaScript, or browser-extension code. The MCP surface is a bounded set of typed discovery, inspection, action, form, screenshot, and file-upload operations.

## Why the browser backend is an extension

Launching a separate automation browser is predictable but loses the user's ordinary profile, active tabs, existing login state, browser extensions, and familiar window. Machine Bridge therefore uses a packaged Manifest V3 extension as the primary backend. It is loaded once into the user's Chromium-family browser and paired with a loopback-only local broker.

The extension works with the current profile and supports:

- listing, creating, activating, and closing tabs;
- reading the current serialized DOM HTML from the main frame or accessible subframes;
- discovering interactive controls, bounded per-document element references, actionability state, geometry, labels, roles, placeholders, and field metadata across accessible frames and open Shadow DOM roots;
- waiting for bounded combinations of URL, load state, page text, and element state;
- structured navigation, click, double-click, hover, focus, fill, type-text, select, check, uncheck, key press, scroll-into-view, and form submission;
- automatic existence/visibility/enabled/editable/stability/hit-target checks before actions, with fixed DevTools mouse/keyboard input for top-frame interactions and a controlled DOM fallback;
- multi-field complex form filling in one operation, bounded to 200 fields and 4 MiB of aggregate text;
- populating file inputs from registered local resource files;
- visible-tab screenshots.

Current support targets Chrome, Chromium, Microsoft Edge, Brave, Vivaldi, and compatible Chromium browsers. The extension must be loaded into the user profile to be controlled; it is not installed into Playwright or an isolated automation profile. Ordinary checkout/global installations expose their package `browser-extension` directory. A versioned local release candidate instead exposes an owner-only stable `release-channels/browser-extension` directory whose path survives candidate-runtime pruning; activation updates its exact candidate files only after Worker/daemon convergence and commits `manifest.json` last. After every Machine Bridge upgrade, reload that same unpacked path so packaged scripts, protocol, and permissions match the runtime. Users who previously loaded an unpacked extension directly from a beta.72-or-earlier versioned candidate-runtime directory must perform one **Load unpacked** migration to the current reported `extension_path`; later local-candidate upgrades keep the directory stable. The current extension contract requires protocol 3 with broker `hello_ack`; the badge and pairing page report success only after protocol/version/capability validation. Pairing material is persisted only after that acknowledgement, an invalid candidate cannot overwrite the previous pairing, and `browser status` reports the expected packaged build, authenticated connected build/protocol/capabilities, and `extension_reload_required`; exact version equality is required in addition to protocol and capabilities. Browser-internal pages, extension stores, some PDF/plugin viewers, inaccessible cross-origin frames, and pages restricted by enterprise policy remain unscriptable.

## One-time browser setup

Keep `machine-mcp` running, then use either the MCP tool `pair_browser_extension` or the local CLI:

```sh
machine-mcp browser setup
```

The command prints the packaged extension directory and keeps the reported pairing URL sanitized, but the URL it actually opens is a process-owned one-shot loopback page whose 30-second bootstrap exists only in the fragment. In the browser:

1. open the extensions page;
2. enable Developer mode;
3. choose **Load unpacked** and select the printed `browser-extension` directory; for a local release candidate this is the stable release-channel directory, not the disposable/versioned runtime package directory;
4. return to the local pairing page.

The first pairing completes automatically. If the extension is already paired to different local state, the page asks for an explicit user gesture: click the Machine Bridge extension icon while the pairing page is active to confirm replacement. This prevents another localhost page from silently overwriting an established pairing. The extension badge shows `ON` when connected; clicking the icon from another page opens the saved local pairing/status page. A candidate upgrade does not bypass this browser-local ownership confirmation.

`Load unpacked` is the self-hosted/development installation path. A mass-market release should package the same extension source as a signed Chrome Web Store and/or Microsoft Edge Add-ons build, so ordinary users install it through the browser store without enabling Developer mode. This repository change does not publish a store listing.

The content script reads pairing material only from the loopback page and stores it in browser-local extension storage. Check status with:

```sh
machine-mcp browser status
machine-mcp browser path
```

The broker is machine-global rather than workspace-global. One local owner listens on the loopback port, and additional Machine Bridge runtimes authenticate to that broker and proxy requests through the same extension connection. This prevents multiple workspaces or stdio clients from repeatedly stealing the browser connection.

## Browser tools

- `browser_status` reports broker role, authenticated extension protocol/version/capabilities, reload state, supported operations, pairing URL, and extension path without returning the pairing token. Concurrent callers may share one broker-startup operation, but each request re-checks its own cancellation after shared startup settles.
- `pair_browser_extension` opens the local pairing page and returns setup steps. Cancellation is checked immediately before the OS launcher; once the launcher invocation is attempted, timeout/cancellation/response loss is an unknown page-open outcome, so inspect the browser before opening the pairing page again.
- `browser_list_tabs` lists current tabs.
- `browser_manage_tabs` creates, activates, or closes a selected tab. Once the corresponding Chrome mutation API is invoked, a rejected or lost response is not proof that the tab mutation did not happen; inspect the tab inventory before retrying.
- `browser_get_source` returns a bounded iterative DOM serialization only when raw markup is genuinely required. Treat the entire result as sensitive: serialized source can expose hidden bootstrap state, session/account identifiers, authentication material, or other values that are not visible in the rendered page. Prefer `browser_inspect_page` for routine semantic/actionability work. `max_bytes` is one aggregate request budget across at most 64 accessible frames; omitted frames and node/byte truncation are explicit.
- `browser_inspect_page` returns snapshot version 3 with one aggregate `max_elements` budget, at most 64 accessible frames, a 100,000-node per-frame scan ceiling, bounded page-controlled strings, URL-userinfo redaction, and explicit scan/frame truncation. Each control includes a reusable `ref` plus visibility, enabled/editable state, viewport geometry, and a per-document epoch used by Computer Use to reject stale same-URL replacements. References are held in a 10,000-entry per-frame LRU; navigation, element replacement, or bounded eviction makes an older ref stale and requires a new inspection.
- `browser_wait` waits until all supplied URL, load-state, page-text, and element-state conditions are true.
- `browser_action` performs one structured navigation or page action. Navigation accepts absolute `http`, `https`, or `file` URLs; script/data schemes are rejected. Pointer and keyboard actions default to `input_mode: auto`, which uses fixed trusted DevTools input in the top frame and falls back to DOM only before side-effecting trusted preparation/input begins. Once a page mutation, Chrome mutation, or trusted-input boundary has been attempted, response loss has an unknown outcome and automatic replay is forbidden. `trusted` always forbids fallback; `dom` never attaches the debugger.
- `browser_fill_form` fills up to 200 fields and can submit once. If a later field fails, the error states how many earlier fields may already have changed without returning their values.
- `browser_upload_files` sets a file input from up to eight registered local resources. Caller filenames must be safe single-component names; derived names have controls and separators removed. MIME overrides must be canonical media types.
- `browser_screenshot` returns native MCP image content, temporarily activates the selected tab only when required, restores the previous active tab when safe, and never focuses another browser window.

Every mutating browser RPC carries explicit dispatch settlement across the local broker. A timeout, disconnect, extension replacement, malformed mutation response, or transport send failure after dispatch was attempted is projected as a fixed non-retryable unknown outcome. Read-only transport failures remain ordinary retryable/unavailable or result-limit failures. This distinction prevents a model or host from replaying a mutation merely because delivery of its result was interrupted.

For stateful GUI trajectories, prefer the higher-level `computer_observe` / `computer_act` pair. `computer_observe` publishes a bounded snapshot and, when available, native image content; `computer_act` consumes that exact snapshot as one-shot mutation authority, performs preflight, dispatches once, observes post-state, and reports dispatch and effect settlement separately. See [Computer Use](COMPUTER_USE.md) for snapshot identity, visual-point constraints, verification, continuation, and retry guidance.

Selectors can use the `ref` returned by inspection, CSS, ID, field name, label text, visible text, ARIA/implicit role, placeholder, and a zero-based match index. `ref` cannot be combined with other fields and becomes stale after navigation or element replacement. Non-ref selectors that match multiple controls fail explicitly unless `index` disambiguates them. The fixed page module traverses open Shadow DOM roots; closed shadow roots remain inaccessible. For frame-specific work, inspect all frames first and then pass `frame_id` to an action. Trusted input currently targets the top frame because DevTools coordinates are top-level; use `input_mode: dom` for an explicitly selected subframe.

## Sensitive form values and files

Ordinary `value` arguments travel through the MCP host, the Worker in remote mode, and the local daemon. For passwords, tokens, personal data, or uploaded files, register a local resource from the terminal:

```sh
machine-mcp resource add account-password /path/to/owner-only/password.txt
machine-mcp resource add application-pdf /path/to/document.pdf
```

Then use `value_resource` for a text field or `resources` for `browser_upload_files`. The local daemon reads the resource only when executing the operation. Results report the alias and outcome, not the resource content. Upload metadata is normalized before reaching the page so path separators, controls, deceptive relative names, and malformed MIME values are rejected. This reduces model-context and result exposure, but the destination page receives the value by design and can transmit it according to its own behavior.

## Application tools

- `list_local_applications` discovers installed applications or launchers.
- `open_local_application` opens an application, URL, or document through the OS launcher. Cancellation is checked immediately before launch; once the process invocation is attempted, timeout/cancellation/response loss is an unknown launch outcome and must be inspected before retrying.
- `inspect_local_application` returns a bounded macOS Accessibility tree.
- `operate_local_application` performs a structured Accessibility action. Local-resource resolution remains pre-dispatch, while mutating JXA/native helpers classify response loss after process start as a non-replayable unknown outcome.

macOS UI inspection and actions require Accessibility permission for the Node/Machine Bridge process. Application discovery and opening are available on supported desktop platforms; structured UI inspection currently targets macOS. The application backend uses fixed package-owned JXA implementation code from `src/local/app-automation-macos-jxa.mjs`, separate from the Node orchestration in `app-automation.mjs`. Read-only JXA operations require a non-empty valid JSON result; mutating JXA/native operations additionally distinguish a definite pre-spawn/preflight failure from response loss after process start, so ambiguous local-process failure is never used as replay evidence. Fixed launch/Accessibility/visual mutation-unknown settlements are public and non-retryable. The caller selects only an application, structured selector, action, and optional bounded value; NUL-containing action text is rejected. `include_values` never returns values for secure-text roles or controls whose metadata indicates passwords, tokens, one-time codes, or payment-card secrets.

Menu-bar and menu subtrees are not recursively expanded by default. This keeps main-window controls within the element/time budget for applications with large localized menu hierarchies. Pass `include_menus: true` to `inspect_local_application` or `operate_local_application` only when the target is a menu item.

## Capability discovery and automatic selection

`resolve_task_capabilities` rescans instruction files, skills, explicit/automatic package commands, policy-visible tool definitions, and relevant local automation metadata on every call. It ranks matching skills and commands, optionally loads the best skill, and returns set-level route advice across direct Bash/argv, process sessions, managed jobs, files/Git, browser, applications, protected resources, and diagnostics. This is not a restriction layer: `exec_command` remains the general shell escape hatch under an effective shell-capable policy.

Application inventory is consulted only when the request's effective account/daemon policy permits application discovery, then cached briefly and refreshed after a bounded interval. A refresh enters that cache only after a final cancellation check, so a caller cancelled at the end of an asynchronous scan cannot publish stale discovery for later requests. A task that directly names an installed app does not need generic “app/window” wording. Per-root discovery failures are returned as bounded `warnings`, and capability resolution reports `application_discovery.available`, warning count, truncation, and a coarse error class instead of silently treating an unreadable inventory as an empty successful scan. A matching `known_refresh_fingerprint` can omit unchanged static context without skipping the fresh capability scan.

This is the strongest reliable server-side automation boundary available through MCP: discovery, refresh, ranking, route-set construction, and progressive skill loading are automatic. The MCP host still owns the model loop and decides whether a recommended tool is exposed, approved, or invoked. Machine Bridge cannot force ChatGPT web or another host to make a call that the host declines.

## Security model

The browser extension has broad page access because generic source inspection and complex forms require it. An authorized `full` client can read pages visible to the extension and perform user-visible actions with the user's logged-in authority. A malicious webpage can contain prompt-injection text, deceptive controls, or actions with financial, legal, account, or privacy consequences.

The implementation reduces avoidable risk as follows:

- all browser/app tools are `full`-only;
- no arbitrary evaluation, caller-provided script source, or caller-selected DevTools method is accepted; trusted input exposes only fixed `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText` sequences;
- loopback HTTP validates `Host`; broker-auth challenge issuance also requires a fixed internal request header, so ordinary cross-origin web requests cannot consume the bounded challenge registry without a preflight the broker does not authorize;
- extension and runtime WebSockets use separate role-bound HMAC exchanges: clients verify a broker server proof before upgrade, then send a one-time client proof under a five-second monotonic deadline; the long-lived owner-only tokens are HMAC keys and never WebSocket bearer subprotocols; extension sockets additionally require the canonical `chrome-extension://` origin for the pinned 32-character Chromium extension ID;
- public pairing status and the HTTP pairing document are token-free; an explicit pair action first binds a one-shot OS-random loopback listener and puts a 30-second bootstrap only in that temporary URL fragment, the `document_start` content script strips it before page scripts and retains it only in the extension isolated world, and a two-step `/pair-auth` exchange first requires an init HMAC under the fragment secret before allocating server state, then requires the broker to prove owner-token-derived knowledge before it releases the extension token; successful grants are one-time, and neither bootstrap nor token is emitted in MCP results or logs;
- an established extension pairing cannot be silently replaced by a public localhost page; manual replacement requires a fresh fragment bootstrap retained by the isolated content script plus an extension-action click;
- arguments, form values, page source, screenshots, and results are not operational log data;
- message, aggregate source/element/frame, form-field, upload, DOM-node/text, concurrency, proxy-route, actionability, and request-deadline limits are enforced; ambiguous selectors, stale refs, hidden/disabled/edit-blocked controls, moving targets, and obscured pointer targets fail explicitly;
- MCP cancellation clears local and broker pending state and propagates a cancellation signal to the extension; an action already delivered to a page or application may still have completed;
- resource-backed text and files are not returned after injection.

These controls do not turn the browser into a sandbox and do not validate business intent. Inspect the page and final values before high-impact submissions. Host confirmation and narrow profiles remain independent controls.
