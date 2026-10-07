import type { z } from 'zod';
import { ApiError } from './problem';

/**
 * An optional JSON body: absent or empty means `{}`. Validators reject an empty body sent with a JSON
 * content type, so routes whose body is optional read it here.
 */
export async function optionalJsonBody<T extends z.ZodType>(
  request: { text(): Promise<string> },
  schema: T,
  hint: string,
): Promise<z.infer<T>> {
  const raw = (await request.text()).trim();
  let value: unknown = {};
  if (raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'validation_failed', `The body must be JSON like ${hint}`);
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', `The body must look like ${hint}`);
  return parsed.data;
}
