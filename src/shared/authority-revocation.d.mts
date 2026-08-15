export type AuthorityRevocation = Readonly<{
  accountId: string;
  accountVersion: number;
  clientId?: string;
  familyId?: string;
}>;

export function normalizeAuthorityRevocation(value: unknown): AuthorityRevocation | null;
export function recordMatchesAuthorityRevocation(record: object, revocation: AuthorityRevocation): boolean;
