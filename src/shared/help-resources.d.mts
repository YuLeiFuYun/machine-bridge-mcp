export interface HelpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const CODE_MODE_SDK_RESOURCE_URI: string;
export const HELP_RESOURCES: readonly HelpResource[];
export function helpResourceMimeType(uri: unknown): string;
export function readHelpResource(uri: unknown): string | null;
