export interface HelpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const HELP_RESOURCES: readonly HelpResource[];
export function readHelpResource(uri: unknown): string | null;
