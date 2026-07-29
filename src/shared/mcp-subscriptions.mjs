import {
  McpProtocolError, asMcpObject, assertBoundedMcpJsonStructure, modernCompleteResult,
} from "./mcp-protocol.mjs";

const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const MAX_RESOURCE_SUBSCRIPTIONS = 256;
const MAX_RESOURCE_SUBSCRIPTION_LENGTH = 8192;

export function validateSubscriptionFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpProtocolError(-32602, "subscriptions/listen requires a notifications object");
  }
  assertBoundedMcpJsonStructure(value, "subscriptions/listen notifications");
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new McpProtocolError(-32602, `subscriptions/listen notifications.${key} must be boolean`);
    }
  }
  if (value.resourceSubscriptions !== undefined) {
    if (!Array.isArray(value.resourceSubscriptions)
      || value.resourceSubscriptions.length > MAX_RESOURCE_SUBSCRIPTIONS
      || !value.resourceSubscriptions.every((uri) => typeof uri === "string" && uri.length <= MAX_RESOURCE_SUBSCRIPTION_LENGTH)) {
      throw new McpProtocolError(-32602, "subscriptions/listen notifications.resourceSubscriptions exceeds its bounded string-array contract");
    }
  }
  return value;
}

export function acceptedSubscriptionFilter(requested, serverCapabilities) {
  const input = asMcpObject(requested);
  const capabilities = asMcpObject(serverCapabilities);
  const tools = asMcpObject(capabilities.tools);
  const prompts = asMcpObject(capabilities.prompts);
  const resources = asMcpObject(capabilities.resources);
  const accepted = {};
  if (input.toolsListChanged === true && tools.listChanged === true) accepted.toolsListChanged = true;
  if (input.promptsListChanged === true && prompts.listChanged === true) accepted.promptsListChanged = true;
  if (input.resourcesListChanged === true && resources.listChanged === true) accepted.resourcesListChanged = true;
  if (resources.subscribe === true && Array.isArray(input.resourceSubscriptions)) {
    const uris = input.resourceSubscriptions.filter((value) => typeof value === "string" && value.length > 0);
    if (uris.length > 0) accepted.resourceSubscriptions = [...new Set(uris)];
  }
  return accepted;
}

export function subscriptionAcknowledgedNotification(subscriptionId, notifications) {
  return {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      _meta: { [SUBSCRIPTION_ID_KEY]: subscriptionId },
      notifications: structuredClone(notifications),
    },
  };
}

export function subscriptionCompleteResult(subscriptionId, serverInfo) {
  return modernCompleteResult({ _meta: { [SUBSCRIPTION_ID_KEY]: subscriptionId } }, serverInfo);
}
