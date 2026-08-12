import {
  clampInt, normalizeBrowserAction, normalizeBrowserSelector, normalizeBrowserWait, normalizeFormAction,
  normalizeInputMode, normalizeNavigationWait, normalizeTabCommand, optionalInteger, optionalString,
  validateNavigationUrl,
} from "./browser-command.mjs";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FORM_FIELDS = 200;
const MAX_FIELD_VALUE_CHARS = 128 * 1024;
const MAX_FORM_VALUE_BYTES = 4 * 1024 * 1024;
const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

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
  }

  async status(context = {}) {
    this.authorizeTool("browser_status");
    await this.ensureStarted(context);
    const bridge = this.bridgeStatus();
    const extension = bridge.extensionInfo;
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
      trusted_input: true,
      input_modes: ["auto", "trusted", "dom"],
      complex_form_fill: true,
      tab_management: true,
      explicit_waits: true,
      screenshots: true,
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
    if (args.open !== false) {
      const launch = await this.createPairingLaunch(this.bridgeStatus().port);
      const command = process.platform === "darwin"
        ? { cmd: "open", argv: [launch.url] }
        : process.platform === "win32"
          ? { cmd: "cmd.exe", argv: ["/d", "/s", "/c", "start", "", launch.url] }
          : { cmd: "xdg-open", argv: [launch.url] };
      try { await this.runProcess(command.cmd, command.argv, 30_000, false, 128 * 1024, context); }
      catch (error) { launch.close(); throw error; }
    }
    return {
      ...status,
      opened_pairing_page: args.open !== false,
      setup_steps: [
        "Open the browser extensions page and enable developer mode.",
        "Load the unpacked extension from extension_path once.",
        "Run pair_browser_extension with opening enabled; the sanitized pairing_url alone contains no pairing grant.",
        "After upgrades, reload the unpacked extension and accept any newly requested browser permission.",
      ],
    };
  }

  async listTabs(args = {}, context = {}) {
    this.authorizeTool("browser_list_tabs");
    return this.request("list_tabs", {
      currentWindow: args.current_window === true,
      includePinned: args.include_pinned !== false,
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
      allFrames: args.all_frames === true,
      maxBytes: clampInt(args.max_bytes, 1024 * 1024, 1, MAX_SOURCE_BYTES),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async inspectPage(args = {}, context = {}) {
    this.authorizeTool("browser_inspect_page");
    return this.request("inspect_page", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      allFrames: args.all_frames !== false,
      maxElements: clampInt(args.max_elements, 300, 1, 1000),
      includeValues: args.include_values === true,
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async act(args = {}, context = {}) {
    this.authorizeTool("browser_action");
    const action = normalizeBrowserAction(args.action);
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
    };
    if (action !== "navigate" && rawUrl) throw new Error("url is only valid for navigate");
    if (action !== "press" && payload.key) throw new Error("key is only valid for press");
    if (payload.inputMode === "trusted" && !["click", "double_click", "hover", "press", "type_text"].includes(action)) {
      throw new Error("input_mode=trusted supports click, double_click, hover, press, and type_text only");
    }
    if (args.value !== undefined) payload.value = boundedValue(args.value, "value");
    if (args.value_resource !== undefined) {
      if (payload.value !== null) throw new Error("value and value_resource are mutually exclusive");
      payload.value = boundedValue(await this.readResourceText(validateResource(args.value_resource)), "value_resource");
    }
    if (payload.value !== null && !["fill", "select", "press", "type_text"].includes(action)) {
      throw new Error(`value is not valid for browser action '${action}'`);
    }
    const pageAction = !["navigate", "reload", "back", "forward"].includes(action);
    const defaultTimeout = pageAction ? Math.min(120, Math.max(30, payload.elementTimeoutMs / 1000 + 5)) : 30;
    const response = await this.request("action", payload, clampInt(args.timeout_seconds, defaultTimeout, 1, 120), context);
    return {
      ...response,
      value_source: args.value_resource !== undefined ? "local-resource" : payload.value === null ? "none" : "mcp-argument",
      value_exposed: false,
    };
  }

  async fillForm(args = {}, context = {}) {
    this.authorizeTool("browser_fill_form");
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error("fields must be a non-empty array");
    if (args.fields.length > MAX_FORM_FIELDS) throw new Error(`fields contains more than ${MAX_FORM_FIELDS} entries`);
    const fields = [];
    let totalValueBytes = 0;
    for (let index = 0; index < args.fields.length; index += 1) {
      const input = args.fields[index];
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`fields[${index}] must be an object`);
      const allowed = new Set(["selector", "value", "value_resource", "action", "sensitive"]);
      for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown fields[${index}] property: ${key}`);
      let value = input.value === undefined ? null : boundedValue(input.value, `fields[${index}].value`);
      if (input.value_resource !== undefined) {
        if (value !== null) throw new Error(`fields[${index}] value and value_resource are mutually exclusive`);
        value = boundedValue(await this.readResourceText(validateResource(input.value_resource)), `fields[${index}].value_resource`);
      }
      if (value !== null) {
        totalValueBytes += Buffer.byteLength(value);
        if (totalValueBytes > MAX_FORM_VALUE_BYTES) throw new Error("form field values exceed 4 MiB total");
      }
      const action = input.action === undefined ? "fill" : normalizeFormAction(input.action);
      if (value === null && !["check", "uncheck", "click"].includes(action)) throw new Error(`fields[${index}] requires value or value_resource`);
      if (value !== null && !["fill", "select"].includes(action)) throw new Error(`fields[${index}] value is not valid for action '${action}'`);
      fields.push({
        selector: normalizeBrowserSelector(input.selector, action),
        value,
        action,
        sensitive: input.sensitive === true || input.value_resource !== undefined,
      });
    }
    const elementTimeoutSeconds = clampInt(args.element_timeout_seconds, 10, 1, 60);
    return this.request("fill_form", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      fields,
      submit: args.submit === true,
      submitSelector: args.submit_selector ? normalizeBrowserSelector(args.submit_selector, "click") : null,
      waitFor: normalizeNavigationWait(args.wait_for),
      elementTimeoutMs: elementTimeoutSeconds * 1000,
    }, clampInt(args.timeout_seconds, Math.max(60, elementTimeoutSeconds + 5), 1, 180), context);
  }

  async uploadFiles(args = {}, context = {}) {
    this.authorizeTool("browser_upload_files");
    if (!Array.isArray(args.resources) || !args.resources.length || args.resources.length > 8) {
      throw new Error("resources must contain 1 to 8 registered resource names");
    }
    const filenames = optionalStringArray(args.filenames, "filenames", 8, 255);
    const mimeTypes = optionalStringArray(args.mime_types, "mime_types", 8, 200);
    if (filenames.length > args.resources.length || mimeTypes.length > args.resources.length) {
      throw new Error("filenames and mime_types cannot contain more entries than resources");
    }
    const files = [];
    let total = 0;
    for (const raw of args.resources) {
      const name = validateResource(raw);
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
    const elementTimeoutSeconds = clampInt(args.element_timeout_seconds, 10, 1, 60);
    const result = await this.request("upload_files", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
      selector: normalizeBrowserSelector(args.selector, "fill"),
      files,
      elementTimeoutMs: elementTimeoutSeconds * 1000,
    }, clampInt(args.timeout_seconds, Math.max(60, elementTimeoutSeconds + 5), 1, 180), context);
    return { ...result, resource_names: args.resources.map(String), resource_contents_exposed: false };
  }

  async screenshot(args = {}, context = {}) {
    this.authorizeTool("browser_screenshot");
    const result = await this.request("screenshot", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      format: args.format === "jpeg" ? "jpeg" : "png",
      quality: clampInt(args.quality, 90, 1, 100),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    const data = String(result.data || "");
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) throw new Error("browser extension returned an invalid screenshot");
    return {
      $mcp: {
        content: [{ type: "image", data: match[2], mimeType: match[1] }],
        structuredContent: {
          tab_id: result.tab_id,
          url: result.url,
          title: result.title,
          mime_type: match[1],
        },
      },
    };
  }
}

function normalizeUploadFilename(value, { derived = false } = {}) {
  let name = String(value || "");
  if (derived) name = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim();
  if (!name || name === "." || name === ".." || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  return name;
}

function normalizeMimeType(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 200) {
    throw new Error("mime_types entries must be valid media types");
  }
  return mime;
}

function optionalStringArray(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0") || !item.length || item.length > maxLength) {
      throw new Error(`${label}[${index}] must be a non-empty string of at most ${maxLength} characters`);
    }
    return item;
  });
}

function boundedValue(value, label) {
  const string = String(value);
  if (string.includes("\0") || string.length > MAX_FIELD_VALUE_CHARS) {
    throw new Error(`${label} exceeds the maximum length or contains a NUL byte`);
  }
  return string;
}

function validateResource(value) {
  const name = String(value || "").trim();
  if (!RESOURCE_NAME.test(name)) throw new Error("value_resource is invalid");
  return name;
}
