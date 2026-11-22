export function isStrictChildPath(root: string, candidate: string): boolean;
export function requireContainedPath(
  root: string,
  candidate: string,
  message: string,
  createError?: (text: string) => Error,
): void;
