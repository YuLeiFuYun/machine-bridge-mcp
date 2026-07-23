export type PortableLogSanitizationOptions = {
  maxChars: number;
  homePaths?: string[];
};

export function sanitizePortableLogText(
  value: unknown,
  options: PortableLogSanitizationOptions,
): string;
