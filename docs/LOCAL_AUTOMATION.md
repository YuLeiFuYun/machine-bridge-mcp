# Local application and browser automation

Machine Bridge exposes two structured local-automation backends under the canonical `full` profile:

1. operating-system application discovery and macOS Accessibility actions;
2. a Chromium extension connected to a loopback broker for the user's existing browser profile, windows, tabs, cookies, and login state.

Neither backend accepts arbitrary caller-supplied AppleScript, JavaScript, or browser-extension code. The MCP surface is a bounded set of typed discovery, inspection, action, form, screenshot, and file-upload operations.

## Why the browser backend is an extension

Launching a separate automation browser is predictable but loses the user's ordinary profile, active tabs, existing login state, browser extensions, and familiar window. Machine Bridge therefore uses a packaged Manifest V3 extension as the primary backend. It is loaded once into the user's Chromium-family browser and paired with a loopback-only local broker.

The extension works with the current profile and supports:

- listing existing tabs;
- reading the current serialized DOM HTML from the main frame or accessible subframes;
- discovering interactive controls, labels, roles, placeholders, and field metadata across accessible frames and open Shadow DOM roots;
- structured navigation, click, focus, fill, select, check, uncheck, key press, and form submission;
- multi-field complex form filling in one operation, bounded to 200 fields and 4 MiB of aggregate text;
- populating file inputs from registered local resource files;
- visible-tab screenshots.

Current support targets Chrome, Chromium, Microsoft Edge, Brave, Vivaldi, and compatible Chromium browsers. After upgrading Machine Bridge, reload the unpacked extension from the browser extensions page so its packaged scripts match the new runtime. Browser-internal pages, extension stores, some PDF/plugin viewers, cross-origin frames denied to the extension, and pages restricted by enterprise policy may not be scriptable.

## One-time browser setup

Keep `machine-mcp` running, then use either the MCP tool `pair_browser_extension` or the local CLI:

```sh
machine-mcp browser setup
```

The command prints the packaged extension directory and opens the local pairing page. In the browser:

1. open the extensions page;
2. enable Developer mode;
3. choose **Load unpacked** and select the printed `browser-extension` directory;
4. return to the local pairing page.

The first pairing completes automatically. If the extension is already paired to different local state, the page asks for an explicit user gesture: click the Machine Bridge extension icon while the pairing page is active to confirm replacement. This prevents another localhost page from silently overwriting an established pairing. The extension badge shows `ON` when connected; clicking the icon from another page opens the saved local pairing/status page.

`Load unpacked` is the self-hosted/development installation path. A mass-market release should package the same extension source as a signed Chrome Web Store and/or Microsoft Edge Add-ons build, so ordinary users install it through the browser store without enabling Developer mode. This repository change does not publish a store listing.

The content script reads pairing material only from the loopback page and stores it in browser-local extension storage. Check status with:

```sh
machine-mcp browser status
machine-mcp browser path
```

The broker is machine-global rather than workspace-global. One local owner listens on the loopback port, and additional Machine Bridge runtimes authenticate to that broker and proxy requests through the same extension connection. This prevents multiple workspaces or stdio clients from repeatedly stealing the browser connection.

## Browser tools

- `browser_status` reports broker role, extension connection, supported operations, pairing URL, and extension path without returning the pairing token.
- `pair_browser_extension` opens the local pairing page and returns setup steps.
- `browser_list_tabs` lists current tabs.
- `browser_get_source` returns bounded current DOM HTML for selected frames.
- `browser_inspect_page` returns bounded interactive-element metadata.
- `browser_action` performs one structured navigation or DOM action. Navigation accepts absolute `http`, `https`, or `file` URLs; script/data schemes are rejected.
- `browser_fill_form` fills up to 200 fields and can submit once.
- `browser_upload_files` sets a file input from up to eight registered local resources. Caller filenames must be safe single-component names; derived names have controls and separators removed. MIME overrides must be canonical media types.
- `browser_screenshot` returns native MCP image content.

Selectors can use CSS, ID, field name, label text, visible text, ARIA/implicit role, placeholder, and a zero-based match index. The fixed page module traverses open Shadow DOM roots; closed shadow roots remain inaccessible. For frame-specific work, inspect all frames first and then pass `frame_id` to an action.

## Sensitive form values and files

Ordinary `value` arguments travel through the MCP host, the Worker in remote mode, and the local daemon. For passwords, tokens, personal data, or uploaded files, register a local resource from the terminal:

```sh
machine-mcp resource add account-password /path/to/owner-only/password.txt
machine-mcp resource add application-pdf /path/to/document.pdf
```

Then use `value_resource` for a text field or `resources` for `browser_upload_files`. The local daemon reads the resource only when executing the operation. Results report the alias and outcome, not the resource content. Upload metadata is normalized before reaching the page so path separators, controls, deceptive relative names, and malformed MIME values are rejected. This reduces model-context and result exposure, but the destination page receives the value by design and can transmit it according to its own behavior.

## Application tools

- `list_local_applications` discovers installed applications or launchers.
- `open_local_application` opens an application, URL, or document through the OS launcher.
- `inspect_local_application` returns a bounded macOS Accessibility tree.
- `operate_local_application` performs a structured Accessibility action.

macOS UI inspection and actions require Accessibility permission for the Node/Machine Bridge process. Application discovery and opening are available on supported desktop platforms; structured UI inspection currently targets macOS. The application backend uses fixed JXA implementation code and requires a non-empty JSON result from `osascript`; missing or malformed helper output fails explicitly. The caller selects only an application, structured selector, action, and optional bounded value; NUL-containing action text is rejected. `include_values` never returns values for secure-text roles or controls whose metadata indicates passwords, tokens, one-time codes, or payment-card secrets.

Menu-bar and menu subtrees are not recursively expanded by default. This keeps main-window controls within the element/time budget for applications with large localized menu hierarchies. Pass `include_menus: true` to `inspect_local_application` or `operate_local_application` only when the target is a menu item.

## Capability discovery and automatic selection

`resolve_task_capabilities` rescans instruction files, skills, explicit/automatic package commands, and relevant local automation metadata on every call. It ranks matching skills and commands, optionally loads the best skill, and compares every canonical-full task with cached installed-application names, so a task that directly names an app does not need generic “app/window” wording. Application inventory is refreshed after a bounded cache interval.

This is the strongest reliable server-side automation boundary available through MCP: discovery, refresh, ranking, and progressive skill loading are automatic. The MCP host still owns the model loop and decides whether a recommended tool is exposed, approved, or invoked. Machine Bridge cannot force ChatGPT web or another host to make a call that the host declines.

## Security model

The browser extension has broad page access because generic source inspection and complex forms require it. An authorized `full` client can read pages visible to the extension and perform user-visible actions with the user's logged-in authority. A malicious webpage can contain prompt-injection text, deceptive controls, or actions with financial, legal, account, or privacy consequences.

The implementation reduces avoidable risk as follows:

- all browser/app tools are `full`-only;
- no arbitrary evaluation or caller-provided script source is accepted;
- loopback HTTP validates `Host`; extension WebSockets require a random bearer subprotocol and a `chrome-extension://` origin;
- runtime-to-broker connections require a separate authenticated subprotocol;
- the pairing token is stored owner-only, embedded only in the non-cacheable local pairing page, and omitted from MCP results and logs;
- an established extension pairing cannot be silently replaced by another localhost page; replacement requires clicking the extension action on the active pairing page;
- arguments, form values, page source, screenshots, and results are not operational log data;
- message, source, form-field, upload, traversal, concurrency, proxy-route, and timeout limits are enforced;
- MCP cancellation clears local and broker pending state and propagates a cancellation signal to the extension; an action already delivered to a page or application may still have completed;
- resource-backed text and files are not returned after injection.

These controls do not turn the browser into a sandbox and do not validate business intent. Inspect the page and final values before high-impact submissions. Host confirmation and narrow profiles remain independent controls.
