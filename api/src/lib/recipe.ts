/**
 * Recipe text from the meal library CSV → what the app stores.
 *
 * Ingredients come as plain lines, "- " bullets and "For the sauce:" section
 * headers (sometimes with items inline: "For serving: 1 avocado; lime wedges").
 * Steps come numbered ("1. Mise en place: …") and usually end with a
 * "Common mistakes:" section, which becomes the meal's tips.
 */
const lines = (v: string): string[] =>
  v
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const unbullet = (l: string): string => l.replace(/^[-•*]\s+/, '').trim();

/** A section header inside an ingredient list ("For the chicken:"). */
export function isIngredientHeader(line: string): boolean {
  return /:\s*$/.test(line.trim());
}

export function cleanIngredients(raw: string): string[] {
  const out: string[] = [];
  for (const l of lines(raw)) {
    const t = unbullet(l);
    const inline = t.match(/^(for [^:]{1,40}):\s*(.+)$/i);
    if (inline?.[1] && inline[2]) {
      out.push(`${inline[1]}:`);
      for (const part of inline[2].split(';')) if (part.trim()) out.push(part.trim());
    } else out.push(t);
  }
  return out;
}

/** "Common mistakes: (1) Too hot. (2) Too cold." → one tip per numbered point. */
function tipsFrom(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (/\(\d+\)/.test(t))
    return t
      .split(/\(\d+\)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [t];
}

export function splitSteps(raw: string): { steps: string[]; tips: string[] } {
  const steps: string[] = [];
  const tips: string[] = [];
  let inTips = false;
  for (const l of lines(raw)) {
    const t = unbullet(l).replace(/^\d+[.)]\s+/, '');
    const head = t.match(/^common mistakes:?\s*(.*)$/i);
    if (head) {
      inTips = true;
      tips.push(...tipsFrom(head[1] ?? ''));
    } else if (inTips) tips.push(t);
    else steps.push(t);
  }
  return { steps, tips };
}
