/**
 * People-friendly dates: "Today", "Tomorrow", "Thu, Oct 8", "2 h ago",
 * "Due Friday", "2 days late" — never "2026-10-04".
 *
 * Dates from the API are plain days ("YYYY-MM-DD", the household's calendar)
 * or timestamps (ISO strings with a time).
 */
const DAY_MS = 86_400_000;

/** A "YYYY-MM-DD" day as local midnight (no time-zone shift). */
function asDay(d: string): Date {
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, dd ?? 1);
}

function todayLocal(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

const daysFromToday = (d: string): number => Math.round((asDay(d).getTime() - todayLocal().getTime()) / DAY_MS);

/** "Today" · "Yesterday" · "Tomorrow" · "Thu, Oct 8" · "Oct 8, 2025" (other years). */
export function day(d: string | null | undefined): string {
  if (!d) return '';
  const n = daysFromToday(d);
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  if (n === 1) return 'Tomorrow';
  const dt = asDay(d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Short day for tight spots: "Oct 8". */
export function shortDay(d: string | null | undefined): string {
  if (!d) return '';
  return asDay(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Due dates: "due today" · "due tomorrow" · "due Friday" · "due Oct 20" · "1 day late". */
export function due(d: string | null | undefined): string {
  if (!d) return '';
  const n = daysFromToday(d);
  if (n < 0) return n === -1 ? '1 day late' : `${-n} days late`;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n < 7) return `due ${asDay(d).toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `due ${shortDay(d)}`;
}

/** Timestamps: "just now" · "5 min ago" · "2 h ago" · "Yesterday" · "Oct 2". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400 && new Date(t).getDate() === new Date().getDate()) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(t);
  return day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
}

/** A moment with its time: "Fri, Oct 2 · 10:22 PM" (or "Today · 10:22 PM"). */
export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dayPart = day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  return `${dayPart} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
