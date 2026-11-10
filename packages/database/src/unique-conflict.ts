interface KnownError {
  readonly code?: unknown;
  readonly meta?: { readonly modelName?: unknown; readonly target?: unknown };
}

/**
 * A unique-key conflict on `model`'s `field`, recognized from the error itself:
 * Prisma 5 on PostgreSQL names the model and lists the key's columns.
 */
export function isUniqueConflict(error: unknown, model: string, field: string): boolean {
  const { code, meta } = error as KnownError;
  return code === "P2002" && meta?.modelName === model && Array.isArray(meta.target) && meta.target.includes(field);
}
