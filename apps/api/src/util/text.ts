/** Replaces every occurrence of the given secrets (e.g. an API key echoed in an upstream error). */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stack frame's line: "    at fn (file:///srv/app/x.js:3:1)", "    at file:///x.js:3:1",
 * "    at new X (<anonymous>)", "    at async Promise.all (index 0)". Not "  at least one of…".
 */
const FRAME = /^\s+at (?:.+ \()?(?:.*:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Text with any stack trace cut off. Some libraries (Mastra's MCP client) put one in an error's message,
 * and its frames name files on this server: the owner sees the lines before the first frame.
 */
export function withoutStack(text: string): string {
  const lines = text.split(/\r?\n/);
  const frame = lines.findIndex((line, index) => index > 0 && FRAME.test(line));
  return (frame > 0 ? lines.slice(0, frame).join('\n') : text).trim();
}

/** An error's message for the owner: without a stack trace. */
export function errorText(error: unknown): string {
  return withoutStack(error instanceof Error ? error.message : String(error));
}
