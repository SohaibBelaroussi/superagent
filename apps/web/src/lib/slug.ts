/**
 * "Market Research" → "market-research": lowercase letters, digits and single dashes, at most `max`
 * characters, never starting or ending with a dash. What department slugs and agent keys accept.
 */
export function slugify(text: string, max = 40): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}
