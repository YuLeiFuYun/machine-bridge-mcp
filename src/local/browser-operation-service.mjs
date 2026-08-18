import {
  browserPairingLaunchUnavailable, browserPairingLaunchUnknown, clampInt, normalizeBrowserAction, normalizeBrowserSelector, normalizeBrowserWait,
  normalizeBrowserSnapshotIdentity, normalizeImageFormat, normalizeInputMode, normalizeNavigationWait, normalizeTabCommand, optionalBoolean, optionalInteger, optionalString,
  validateNavigationUrl,
} from "./browser-command.mjs";
import { BrowserComputerObservationService } from "./browser-computer-observation-service.mjs";
import { BrowserTrustedInputHealth, TRUSTED_INPUT_QUARANTINE_FALLBACK } from "./browser-trusted-input-health.mjs";
import {
  boundedBrowserValue, normalizeMimeType, normalizeUploadFilename, optionalStringArray, prepareBrowserFormField,
  resolveBrowserActionValue, validateBrowserResource,
} from "./browser-resource-input.mjs";
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FORM_FIELDS = 200;
const MAX_FORM_VALUE_BYTES = 4 * 1024 * 1024;
export class BrowserOperationService {
  constructor({
    authorizeTool,
    ensureStarted,
    request,
    bridgeStatus,
    createPairingLaunch,
    extensionPath,
    expectedExtensionVersion,
    expectedExtensionId,
    runProcess,
    readResourceText,
    readResourceBinary,
    throwIfCancelled = () => {},
    logger = null,
  }) {
    this.authorizeTool = authorizeTool;
    this.ensureStarted = ensureStarted;
    this.request = request;
    this.bridgeStatus = bridgeStatus;
    this.createPairingLaunch = createPairingLaunch;
    this.extensionPath = extensionPath;
    this.expectedExtensionVersion = expectedExtensionVersion;
    this.expectedExtensionId = expectedExtensionId;
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.readResourceBinary = readResourceBinary;
    this.throwIfCancelled = throwIfCancelled;
    this.trustedInputHealth = new BrowserTrustedInputHealth({ logger });
    this.computerObservation = new BrowserComputerObservationService({
      authorizeTool: (tool) => this.authorizeTool(tool),
      request: (...args) => this.requestComputerObservation(...args),
      bridgeStatus: () => this.bridgeStatus(),
      inspectPage: (args, context) => this.inspectPage(args, context),
      screenshot: (args, context) => this.screenshot(args, context),
    });
  }
  async status(context = {}) {
    this.authorizeTool("browser_status");
    await this.ensureStarted(context);
    const bridge = this.bridgeStatus();
    const extension = bridge.extensionInfo;
    const trustedHealth = this.trustedInputHealth.status(bridge);
    return {
      available: true,
      connected: bridge.extensionConnected,
      broker_role: bridge.brokerRole,
      runtime_clients: Number(bridge.runtime_clients) || 0,
      routed_requests: Number(bridge.routed_requests) || 0,
      endpoint: `ws://127.0.0.1:${bridge.port}/extension`,
      pairing_url: `http://127.0.0.1:${bridge.port}/pair`,
      extension_path: this.extensionPath,
      expected_extension_version: this.expectedExtensionVersion,
      expected_extension_id: this.expectedExtensionId,
      extension_id: extension?.extension_id || "",
      extension_protocol: extension?.protocol || null,
      extension_version: extension?.version || "",
      extension_capabilities: extension?.capabilities || [],
      extension_reload_required: bridge.extensionReloadRequired,
      supported_browsers: ["Chrome", "Chromium", "Microsoft Edge", "Brave", "Vivaldi", "other Chromium browsers with Manifest V3"],
      controls_existing_profile: true,
      controls_extension_profile: true,
      launches_browser_process: false,
      launches_separate_automation_profile: false,
      profile_identity_verifiable: false,
      uses_existing_tabs_and_login_state: true,
      source_access: true,
      semantic_snapshot_refs: true,
      actionability_waits: true,
      trusted_input: trustedHealth.available,
      trusted_input_quarantined: trustedHealth.quarantined,
      trusted_input_health: !bridge.extensionConnected ? "disconnected" : trustedHealth.quarantined ? "quarantined" : trustedHealth.supported ? "ready" : "unsupported",
      input_modes: ["auto", "trusted", "dom"],
      complex_form_fill: true,
      tab_management: true,
      explicit_waits: true,
      screenshots: true,
      computer_observation_v1: extension?.capabilities?.includes("computer_observation_v1") === true,
      cdp_accessibility_snapshot: extension?.capabilities?.includes("cdp_accessibility_snapshot") === true,
      cdp_surface_screenshot: extension?.capabilities?.includes("cdp_surface_screenshot") === true,
      backend_node_trusted_input: extension?.capabilities?.includes("backend_node_trusted_input") === true && !trustedHealth.quarantined,
      restricted_pages: ["browser-internal pages", "extension stores", "some PDF/plugin viewers", "pages blocked by enterprise policy"],
      security: {
        loopback_only: true,
        bearer_pairing_token: false,
        short_lived_pairing_grant: true,
        ephemeral_pairing_listener: true,
        one_time_hmac_socket_auth: true,
        long_lived_tokens_on_wire: false,
        pinned_extension_identity: true,
        arbitrary_extension_code_from_mcp: false,
        resource_values_returned_to_model: false,
      },
    };
  }
  async pair(args = {}, context = {}) {
    this.authorizeTool("pair_browser_extension");
    const status = await this.status(context);
    const open = optionalBoolean(args.open, "open", true);
    if (open) {
      const launch = await this.createPairingLaunch(this.bridgeStatus().port);
      const command = process.platform === "darwin"
        ? { cmd: "open", argv: [launch.url] }
        : process.platform === "win32"
          ? { cmd: "cmd.exe", argv: ["/d", "/s", "/c", "start", "", launch.url] }
          : { cmd: "xdg-open", argv: [launch.url] };
      this.throwIfCancelled(context);
      try {
        await this.runProcess(command.cmd, command.argv, 30_000, false, 128 * 1024, context, undefined, null, { nonReplayableMutation: true });
      } catch (error) {
        launch.close();
        if (error?.details?.reason === "process_outcome_unknown_after_spawn") throw browserPairingLaunchUnknown();
        if (error?.details?.reason === "process_failed_before_spawn") throw browserPairingLaunchUnavailable();
        throw error;
      }
    }
    return {
      ...status,
      opened_pairing_page: open,
      setup_steps: [
        "Open the browser extensions page and enable developer mode.",
        "Load the unpacked extension from extension_path once.",
        "Run pair_browser_extension with opening enabled; the sanitized pairing_url alone contains no pairing grant.",
        "After upgrades, reload the same unpacked extension path and accept any newly requested browser permission; older local-candidate installs may need one Load unpacked migration to the current stable extension_path.",
      ],
    };
  }
  async listTabs(args = {}, context = {}) {
    this.authorizeTool("browser_list_tabs");
    return this.request("list_tabs", {
      currentWindow: optionalBoolean(args.current_window, "current_window", false),
      includePinned: optionalBoolean(args.include_pinned, "include_pinned", true),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }
  async manageTabs(args = {}, context = {}) {
    this.authorizeTool("browser_manage_tabs");
    return this.request("manage_tabs", normalizeTabCommand(args), clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async wait(args = {}, context = {}) {
    this.authorizeTool("browser_wait");
    const params = normalizeBrowserWait(args);
    const conditionTimeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    return this.request("wait", params, conditionTimeoutSeconds + 5, context);
  }

  async getSource(args = {}, context = {}) {
    this.authorizeTool("browser_get_source");
    return this.request("get_source", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      allFrames: optionalBoolean(args.all_frames, "all_frames", false),
      maxBytes: clampInt(args.max_bytes, 1024 * 1024, 1, MAX_SOURCE_BYTES),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async inspectPage(args = {}, context = {}) {
    this.authorizeTool("browser_inspect_page");
    return this.request("inspect_page", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      allFrames: optionalBoolean(args.all_frames, "all_frames", true),
      maxElements: clampInt(args.max_elements, 300, 1, 1000),
      includeValues: optionalBoolean(args.include_values, "include_values", false),
      focusQuery: optionalString(args.focus_query, "focus_query", 1000),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  documentState(args = {}, context = {}) { return this.computerObservation.documentState(args, context); }
  observeComputer(args = {}, context = {}) { return this.computerObservation.observe(args, context); }
  pointAction(args = {}, context = {}) { return this.computerObservation.pointAction(args, context); }
  async backendNodeAction(args = {}, context = {}) {
    const action = args.action;
    if (typeof action !== "string" || !["click", "double_click", "hover", "drag", "scroll", "press", "type_text", "fill", "check", "uncheck", "submit"].includes(action)) throw new Error("snapshot backend action must be click, double_click, hover, drag, scroll, press, type_text, fill, check, uncheck, or submit");
    if (!["fill", "type_text"].includes(action) && (args.value !== undefined || args.value_resource !== undefined)) throw new Error(`value and value_resource are not valid for snapshot backend ${action}`);
    if (action !== "press" && args.key !== undefined) throw new Error(`key is not valid for snapshot backend ${action}`);
    this.computerObservation.preflightBackendNodeAction(args);
    this.trustedInputHealth.assertTrustedAvailable(this.bridgeStatus());
    const resolved = await resolveBrowserActionValue(args, this.readResourceText);
    return this.computerObservation.backendNodeAction({ ...args, value: resolved.value ?? undefined }, context);
  }
  async act(args = {}, context = {}) {
    this.authorizeTool("browser_action");
    const action = normalizeBrowserAction(args.action);
    const valueActions = new Set(["fill", "type_text", "select"]);
    if (!valueActions.has(action) && (args.value !== undefined || args.value_resource !== undefined)) {
      throw new Error(`value and value_resource are not valid for browser action ${action}`);
    }
    if (valueActions.has(action) && args.value === undefined && args.value_resource === undefined) {
      throw new Error(`browser action ${action} requires value or value_resource`);
    }
    const rawUrl = optionalString(args.url, "url", 32768);
    const payload = {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      action,
      selector: normalizeBrowserSelector(args.selector, action),
      url: action === "navigate" ? validateNavigationUrl(rawUrl) : "",
      value: null,
      key: optionalString(args.key, "key", 100),
      waitFor: normalizeNavigationWait(args.wait_for),
      inputMode: normalizeInputMode(args.input_mode),
      elementTimeoutMs: clampInt(args.element_timeout_seconds, 10, 1, 60) * 1000,
      expectedIdentity: normalizeBrowserSnapshotIdentity(args.expected_ref_identity),
      expectedTabUrl: optionalString(args.expected_tab_url, "expected_tab_url", 32768),
      expectedDocumentEpoch: optionalString(args.expected_document_epoch, "expected_document_epoch", 9000), expectedHistoryEntryKey: optionalString(args.expected_history_entry_key, "expected_history_entry_key", 512),
    };
    if (!["navigate", "reload", "back", "forward"].includes(action) && payload.expectedTabUrl) throw new Error("expected_tab_url is only valid for snapshot-bound navigation actions");
    if (!["reload", "back", "forward"].includes(action) && payload.expectedDocumentEpoch) throw new Error("expected_document_epoch is only valid for snapshot-bound reload, back, or forward");
    if (!["reload", "back", "forward"].includes(action) && payload.expectedHistoryEntryKey) throw new Error("expected_history_entry_key is only valid for snapshot-bound reload, back, or forward");
    if (action !== "navigate" && rawUrl) throw new Error("url is only valid for navigate");
    if (action !== "press" && payload.key) throw new Error("key is only valid for press");
    if (payload.inputMode === "trusted" && !["click", "double_click", "hover", "press", "type_text"].includes(action)) {
      throw new Error("input_mode=trusted supports click, double_click, hover, press, and type_text only");
    }
    const trustedDecision = this.trustedInputHealth.pageInputMode({ inputMode: payload.inputMode, action, bridge: this.bridgeStatus() });
    payload.inputMode = trustedDecision.inputMode;
    const resolvedValue = await resolveBrowserActionValue(args, this.readResourceText);
    payload.value = resolvedValue.value;
    if (payload.value !== null && !["fill", "select", "press", "type_text"].includes(action)) {
      throw new Error(`value is not valid for browser action '${action}'`);
    }
    const pageAction = !["navigate", "reload", "back", "forward"].includes(action);
    const defaultTimeout = pageAction ? Math.min(120, Math.max(30, payload.elementTimeoutMs / 1000 + 5)) : 30;
    let response;
    try {
      response = await this.request("action", payload, clampInt(args.timeout_seconds, defaultTimeout, 1, 120), context);
    } catch (error) {
      this.trustedInputHealth.noteAmbiguousFailure(error, this.bridgeStatus());
      throw error;
    }
    return {
      ...response,
      ...(trustedDecision.fallback ? {
        input_mode: "dom",
        trusted_input_fallback: true,
        fallback_reason: TRUSTED_INPUT_QUARANTINE_FALLBACK,
      } : {}),
      value_source: resolvedValue.source,
      value_exposed: false,
    };
  }

  async requestComputerObservation(method, params, timeoutSeconds, context) {
    const trustedMethod = method === "point_action" || method === "backend_node_action";
    if (trustedMethod) this.trustedInputHealth.assertTrustedAvailable(this.bridgeStatus());
    try {
      return await this.request(method, params, timeoutSeconds, context);
    } catch (error) {
      if (trustedMethod) this.trustedInputHealth.noteAmbiguousFailure(error, this.bridgeStatus());
      throw error;
    }
  }

  async fillForm(args = {}, context = {}) {
    this.authorizeTool("browser_fill_form");
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error("fields must be a non-empty array");
    if (args.fields.length > MAX_FORM_FIELDS) throw new Error(`fields contains more than ${MAX_FORM_FIELDS} entries`);
    const tabId = optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER);
    const frameId = optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER);
    const submit = optionalBoolean(args.submit, "submit", false);
    const submitSelector = args.submit_selector === undefined ? null : normalizeBrowserSelector(args.submit_selector, "click");
    const waitFor = normalizeNavigationWait(args.wait_for);
    const elementTimeoutSeconds = clampInt(args.element_timeout_seconds, 10, 1, 60);
    const timeoutSeconds = clampInt(args.timeout_seconds, Math.max(60, elementTimeoutSeconds + 5), 1, 180);
    const prepared = args.fields.map((input, index) => prepareBrowserFormField(input, index));
    const fields = [];
    let totalValueBytes = 0;
    for (const field of prepared) {
      let value = field.value;
      if (field.resourceName) value = boundedBrowserValue(await this.readResourceText(field.resourceName), `fields[${field.index}].value_resource`);
      if (value !== null) {
        totalValueBytes += Buffer.byteLength(value);
        if (totalValueBytes > MAX_FORM_VALUE_BYTES) throw new Error("form field values exceed 4 MiB total");
      }
      fields.push({ selector: field.selector, value, action: field.action, sensitive: field.sensitive || Boolean(field.resourceName) });
    }
    return this.request("fill_form", {
      tabId, frameId, fields, submit, submitSelector, waitFor, elementTimeoutMs: elementTimeoutSeconds * 1000,
    }, timeoutSeconds, context);
  }

  async uploadFiles(args = {}, context = {}) {
    this.authorizeTool("browser_upload_files");
    if (!Array.isArray(args.resources) || !args.resources.length || args.resources.length > 8) {
      throw new Error("resources must contain 1 to 8 registered resource names");
    }
    const tabId = optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER);
    const frameId = optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER);
    const selector = normalizeBrowserSelector(args.selector, "fill");
    const elementTimeoutSeconds = clampInt(args.element_timeout_seconds, 10, 1, 60);
    const timeoutSeconds = clampInt(args.timeout_seconds, Math.max(60, elementTimeoutSeconds + 5), 1, 180);
    const resourceNames = args.resources.map(validateBrowserResource);
    const filenames = optionalStringArray(args.filenames, "filenames", 8, 255);
    const mimeTypes = optionalStringArray(args.mime_types, "mime_types", 8, 200);
    if (filenames.length > resourceNames.length || mimeTypes.length > resourceNames.length) {
      throw new Error("filenames and mime_types cannot contain more entries than resources");
    }
    const files = [];
    let total = 0;
    for (const name of resourceNames) {
      const resource = this.readResourceBinary(name);
      total += resource.buffer.length;
      if (total > 5 * 1024 * 1024) throw new Error("browser upload resources exceed 5 MiB total");
      const suppliedFilename = filenames[files.length];
      const derivedFilename = resource.path.split(/[\\/]/).pop() || name;
      files.push({
        filename: normalizeUploadFilename(suppliedFilename || derivedFilename, { derived: !suppliedFilename }),
        mime: normalizeMimeType(mimeTypes[files.length] || "application/octet-stream"),
        data: resource.buffer.toString("base64"),
      });
    }
    const result = await this.request("upload_files", {
      tabId, frameId, selector, files, elementTimeoutMs: elementTimeoutSeconds * 1000,
    }, timeoutSeconds, context);
    return { ...result, resource_names: resourceNames, resource_contents_exposed: false };
  }

  async screenshot(args = {}, context = {}) {
    this.authorizeTool("browser_screenshot");
    const result = await this.request("screenshot", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      format: normalizeImageFormat(args.format, "format"),
      quality: clampInt(args.quality, 90, 1, 100),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    const data = typeof result.data === "string" ? result.data : "";
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) throw new Error("browser extension returned an invalid screenshot");
    return {
      $mcp: {
        content: [{ type: "image", data: match[2], mimeType: match[1] }],
        structuredContent: {
          tab_id: result.tab_id,
          url: result.url,
          title: result.title, tab_metadata_verified: result.tab_metadata_verified === true,
          mime_type: match[1],
        },
      },
    };
  }
}
