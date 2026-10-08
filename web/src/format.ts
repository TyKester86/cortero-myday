/**
 * "1 member", "3 members", "1 entry", "2 entries" — one string, so it reads (and is read aloud, or copied)
 * as one phrase, with the right singular or plural.
 */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
