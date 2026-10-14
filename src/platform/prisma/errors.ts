/** True when the database refused a write because a unique key would repeat (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
  );
}
