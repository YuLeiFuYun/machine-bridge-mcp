export function validateSubscriptionFilter(value: unknown): Record<string, unknown>;
export function acceptedSubscriptionFilter(requested: unknown, serverCapabilities: unknown): Record<string, unknown>;
export function subscriptionAcknowledgedNotification(subscriptionId: string | number, notifications: Record<string, unknown>): Record<string, unknown>;
export function subscriptionCompleteResult(subscriptionId: string | number, serverInfo?: Record<string, unknown>): Record<string, unknown>;
