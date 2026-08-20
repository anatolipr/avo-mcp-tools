import { z } from 'zod';

/**
 * Status is a free-form label, not a closed enum — the DB column has no CHECK
 * constraint and the web UI's filter dropdown is populated from distinct values
 * actually in use (see buildFacets in web/routes.ts), so any normalized string
 * works end to end. This schema only enforces a consistent shape (lowercase,
 * hyphenated) so casing/typo variants don't silently fragment that dropdown.
 */
const STATUS_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function normalizeStatus(status: string): string {
  return status.trim().toLowerCase().replace(/\s+/g, '-');
}

export function statusSchema(defaults: readonly string[]): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .max(40)
    .transform(normalizeStatus)
    .refine((s) => STATUS_PATTERN.test(s), {
      message: 'status must be lowercase alphanumeric with hyphens, e.g. "active" or "needs-review"',
    })
    .describe(`free-form status label, normalized to lowercase-hyphenated; conventional values: ${defaults.join(', ')} — but any value is accepted`);
}
