/**
 * Ingredient quantity parsing + merging, ported verbatim in behavior from the
 * script (parseIng_ / mergeIngLines_ / fmtQty_):
 * "2 lb chicken breast" + "1 lb chicken breast" -> "3 lb chicken breast".
 * Lines without parseable quantities ("Salt to taste") dedupe by text.
 */
const UNITS = new Set([
  'cup', 'tbsp', 'tsp', 'lb', 'oz', 'can', 'clove', 'slice', 'stalk', 'bunch', 'head', 'package', 'pkg',
  'g', 'gram', 'kg', 'ml', 'l', 'liter', 'pint', 'quart', 'gallon', 'dozen', 'pc', 'piece', 'scoop', 'rib', 'sprig',
]);

const FRAC: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

function qty(tok: string): number | null {
  let v = 0;
  let found = false;
  for (const p of tok.trim().split(/\s+/)) {
    let num: number | null = null;
    const direct = FRAC[p];
    if (direct !== undefined) num = direct;
    else {
      const mf = p.match(/^(\d+)([¼½¾⅓⅔⅛⅜⅝⅞])$/);
      const mixed = mf?.[2] !== undefined ? FRAC[mf[2]] : undefined;
      if (mf && mixed !== undefined) num = Number(mf[1]) + mixed;
      else if (/^\d+\/\d+$/.test(p)) {
        const [a, b] = p.split('/').map(Number);
        if (a !== undefined && b) num = a / b;
      } else if (/^\d*\.?\d+$/.test(p)) num = Number(p);
    }
    if (num === null || Number.isNaN(num)) return null;
    v += num;
    found = true;
  }
  return found ? v : null;
}

export interface ParsedIngredient {
  text: string;
  qty: number | null;
  unit: string;
  name: string;
  key: string;
}

export function parseIngredient(line: string): ParsedIngredient {
  let t = line.trim();
  const out: ParsedIngredient = { text: t, qty: null, unit: '', name: t, key: `x|${t.toLowerCase()}` };
  const m = t.match(/^([\d\s/.¼½¾⅐-⅞]+)\s+(.*)$/);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const q = qty(m[1]);
    if (q !== null && q > 0) {
      out.qty = q;
      t = m[2].trim();
    }
  }
  if (out.qty !== null) {
    const w = t.split(/\s+/);
    if (w.length > 1) {
      const u = (w[0] ?? '').toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
      if (UNITS.has(u)) {
        out.unit = u;
        t = w.slice(1).join(' ');
      }
    }
    out.name = itemName(t);
    // "4 garlic cloves" → 4 clove garlic (same item as "4 cloves garlic").
    const words = out.name.split(' ');
    const last = (words[words.length - 1] ?? '').toLowerCase().replace(/s$/, '');
    if (!out.unit && words.length > 1 && UNITS.has(last)) {
      out.unit = last;
      out.name = words.slice(0, -1).join(' ');
    }
    out.key = `${out.unit ? `${out.unit}|` : 'n|'}${matchKey(out.name)}`;
  }
  return out;
}

/**
 * The thing you buy, from the rest of a recipe line: drop "(about 5 breasts)"
 * and "- taste and adjust" asides and the prep after the comma ("diced"),
 * but keep leading descriptors ("boneless, skinless chicken breasts").
 */
function itemName(rest: string): string {
  const t = rest
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+[-—–]\s+/)[0]!
    .replace(/\s+/g, ' ')
    .trim();
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  let name = parts[0] ?? t;
  let i = 1;
  while (!name.includes(' ') && i < parts.length) name = `${name} ${parts[i++]}`;
  return name.trim() || t;
}

/** Words that don't change what's on the shelf for matching purposes. */
const DESCRIPTORS = new Set([
  'boneless', 'skinless', 'bone-in', 'skin-on', 'large', 'medium', 'small', 'fresh', 'freshly', 'ripe', 'whole',
  'packed', 'finely', 'thinly', 'coarsely', 'roughly', 'chopped', 'diced', 'minced', 'sliced', 'grated', 'shredded',
  'crumbled', 'extra-virgin', 'low-sodium', 'frozen', 'thawed', 'cold', 'warm', 'softened', 'melted',
]);

function matchKey(name: string): string {
  const words = name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !DESCRIPTORS.has(w));
  if (!words.length) return name.toLowerCase();
  const last = words[words.length - 1]!;
  words[words.length - 1] = /oes$/.test(last) ? last.slice(0, -2) : /[^s]s$/.test(last) ? last.slice(0, -1) : last;
  return words.join(' ');
}

/** "For the sauce:" — a section header in a recipe, not something to buy. */
export function isSectionHeader(line: string): boolean {
  return /:\s*$/.test(line.trim());
}

export function formatQty(q: number): string {
  if (Math.abs(q - Math.round(q)) < 0.001) return String(Math.round(q));
  const whole = Math.floor(q + 0.001);
  const frac = q - whole;
  const fr: Array<[string, number]> = [['¼', 0.25], ['⅓', 1 / 3], ['½', 0.5], ['⅔', 2 / 3], ['¾', 0.75]];
  for (const [sym, val] of fr) if (Math.abs(frac - val) < 0.06) return (whole ? String(whole) : '') + sym;
  return String(Math.round(q * 100) / 100);
}

export function mergeIngredientLines(lines: string[]): string[] {
  const map = new Map<string, { qty: number; hasQty: boolean; unit: string; name: string; text: string }>();
  for (const line of lines) {
    if (isSectionHeader(line)) continue;
    const p = parseIngredient(line);
    const e = map.get(p.key) ?? { qty: 0, hasQty: false, unit: p.unit, name: p.name, text: p.text };
    if (p.qty !== null) {
      e.qty += p.qty;
      e.hasQty = true;
    }
    map.set(p.key, e);
  }
  return [...map.values()].map((x) => (x.hasQty ? `${formatQty(x.qty)}${x.unit ? ` ${x.unit}` : ''} ${x.name}` : x.text));
}
