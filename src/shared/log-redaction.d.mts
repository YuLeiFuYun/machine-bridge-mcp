export type PortableLogSanitizationOptions = {
  maxChars: number;
  homePaths?: string[];
};

export function isSensitiveLogFieldName(value: unknown): boolean;

export function sanitizePortableLogText(
  value: unknown,
  options: PortableLogSanitizationOptions,
): string;
