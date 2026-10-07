/** Whether a query failed on a unique constraint (Postgres 23505), directly or as Drizzle's cause. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
