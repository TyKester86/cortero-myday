import { useState } from 'react';
import { CAL_REPEATS, type CalendarEvent, type CalendarEventFields, type CalendarFeedLink, type CalendarOccurrence, type CalendarResponse, type CalRepeat } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { day } from '../../dates';
import { useSession } from '../../session';

/** "15:30" → "3:30 PM". */
export function clock(t: string | null): string {
  if (!t) return '';
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}

export const timeLabel = (o: Pick<CalendarOccurrence, 'startTime' | 'endTime'>): string =>
  o.startTime ? `${clock(o.startTime)}${o.endTime ? ` – ${clock(o.endTime)}` : ''}` : 'All day';

const REPEAT_LABEL: Record<CalRepeat, string> = { none: 'Doesn’t repeat', daily: 'Every day', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
const REMINDERS: Array<[number | null, string]> = [
  [null, 'No reminder'],
  [0, 'At the start'],
  [10, '10 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [1440, '1 day before'],
];

const isoToday = (): string => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};
const plusDays = (d: string, n: number): string => {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(y ?? 1970, (m ?? 1) - 1, (dd ?? 1) + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

const blank = (startsOn: string): CalendarEventFields => ({
  title: '',
  notes: '',
  location: '',
  startsOn,
  startTime: null,
  endTime: null,
  repeat: 'none',
  repeatUntil: null,
  adultsOnly: false,
  remindMinutes: null,
  people: [],
});

/** The household calendar: what's coming up, for everyone or one person; grown-ups add and edit. */
export default function Calendar() {
  const { members, isAdult } = useSession();
  const [from, setFrom] = useState(isoToday());
  const to = plusDays(from, 60);
  const { data, error, reload } = useLoad<CalendarResponse>(`/api/calendar?from=${from}&to=${to}`);
  const [who, setWho] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; f: CalendarEventFields } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const shown = data.occurrences.filter((o) => who === null || o.people.length === 0 || o.people.some((p) => p.id === who));
  const byDay = new Map<string, CalendarOccurrence[]>();
  for (const o of shown) byDay.set(o.date, [...(byDay.get(o.date) ?? []), o]);

  const edit = (o: CalendarOccurrence): void => {
    const e = data.events.find((x) => x.id === o.eventId);
    if (e) setEditing({ id: e.id, f: { ...(e as CalendarEvent) } });
  };

  return (
    <section data-testid="calendar">
      <h1>Calendar</h1>
      <div className="chips" role="group" aria-label="Whose calendar">
        <button className={who === null ? 'chip on' : 'chip'} onClick={() => setWho(null)}>
          Everyone
        </button>
        {members.map((m) => (
          <button key={m.id} className={who === m.id ? 'chip on' : 'chip'} onClick={() => setWho(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
      {data.canEdit && !editing && (
        <button className="btn" data-testid="add-event" onClick={() => setEditing({ id: null, f: blank(isoToday()) })}>
          + Add an event
        </button>
      )}
      {editing && (
        <EventForm
          id={editing.id}
          initial={editing.f}
          onCancel={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            setMsg(m);
            reload();
          }}
          onDelete={
            editing.id === null
              ? undefined
              : () =>
                  void confirm({ title: `Delete “${editing.f.title}”?`, body: editing.f.repeat !== 'none' ? 'Every repeat goes with it.' : undefined, confirmLabel: 'Delete', danger: true }).then(
                    (y) =>
                      void (
                        y &&
                        api(`/api/calendar/events/${editing.id}`, 'DELETE').then(() => {
                          setEditing(null);
                          setMsg('Deleted.');
                          reload();
                        })
                      ),
                  )
          }
        />
      )}

      <div data-testid="agenda">
        {byDay.size === 0 && <p className="muted">Nothing on the calendar for the next two months{who === null ? '' : ' for them'}.</p>}
        {[...byDay.entries()].map(([d, list]) => (
          <div key={d} className="cal-day">
            <h2 className={d === isoToday() ? 'cal-date today' : 'cal-date'}>{day(d)}</h2>
            {list.map((o) => (
              <button
                key={`${o.eventId}-${d}`}
                className="card cal-event"
                data-testid="cal-event"
                onClick={() => (data.canEdit ? edit(o) : undefined)}
                disabled={!data.canEdit}
              >
                <span className="cal-time">{timeLabel(o)}</span>
                <span className="cal-body">
                  <b>{o.title}</b>
                  <small className="muted">
                    {o.people.length ? o.people.map((p) => p.name).join(', ') : 'Everyone'}
                    {o.location && ` · ${o.location}`}
                    {o.repeat !== 'none' && ` · ${REPEAT_LABEL[o.repeat].toLowerCase()}`}
                    {o.adultsOnly && ' · grown-ups only'}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn small ghost" onClick={() => setFrom(plusDays(from, -60))}>
          ← Earlier
        </button>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => setFrom(plusDays(from, 60))}>
          Later →
        </button>
      </div>
      {isAdult && data.feed && <Subscribe active={data.feed.active} onChange={reload} />}
    </section>
  );
}

function EventForm({
  id,
  initial,
  onCancel,
  onSaved,
  onDelete,
}: {
  id: number | null;
  initial: CalendarEventFields;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onDelete?: () => void;
}) {
  const { members } = useSession();
  const [f, setF] = useState<CalendarEventFields>(initial);
  const [allDay, setAllDay] = useState(!initial.startTime);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (m: number): void => setF({ ...f, people: f.people.includes(m) ? f.people.filter((x) => x !== m) : [...f.people, m] });
  return (
    <form
      className="card form"
      data-testid="event-form"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        const body: CalendarEventFields = { ...f, startTime: allDay ? null : f.startTime, endTime: allDay ? null : f.endTime, remindMinutes: allDay ? null : f.remindMinutes };
        void api(id === null ? '/api/calendar/events' : `/api/calendar/events/${id}`, id === null ? 'POST' : 'PUT', body)
          .then(() => onSaved(id === null ? `Added “${f.title}”.` : 'Saved.'))
          .catch((e2: unknown) => setErr(e2 instanceof Error ? e2.message : 'Could not save'));
      }}
    >
      <h2>{id === null ? 'New event' : 'Edit event'}</h2>
      <label>
        What
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Soccer practice" required maxLength={120} />
      </label>
      <label>
        Date
        <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} required />
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
      </label>
      {!allDay && (
        <div className="inline">
          <label>
            Starts
            <input type="time" value={f.startTime ?? ''} onChange={(e) => setF({ ...f, startTime: e.target.value || null })} required />
          </label>
          <label>
            Ends (optional)
            <input type="time" value={f.endTime ?? ''} onChange={(e) => setF({ ...f, endTime: e.target.value || null })} />
          </label>
        </div>
      )}
      <fieldset className="pin-choice">
        <legend className="small">Who it’s for (none picked = everyone)</legend>
        <div className="chips">
          {members.map((m) => (
            <button type="button" key={m.id} className={f.people.includes(m.id) ? 'chip on' : 'chip'} aria-pressed={f.people.includes(m.id)} onClick={() => toggle(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        Repeats
        <select value={f.repeat} onChange={(e) => setF({ ...f, repeat: CAL_REPEATS.find((r) => r === e.target.value) ?? 'none' })}>
          {CAL_REPEATS.map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {f.repeat !== 'none' && (
        <label>
          Until (optional)
          <input type="date" value={f.repeatUntil ?? ''} min={f.startsOn} onChange={(e) => setF({ ...f, repeatUntil: e.target.value || null })} />
        </label>
      )}
      {!allDay && (
        <label>
          Reminder
          <select value={f.remindMinutes === null ? '' : String(f.remindMinutes)} onChange={(e) => setF({ ...f, remindMinutes: e.target.value === '' ? null : Number(e.target.value) })}>
            {REMINDERS.map(([v, label]) => (
              <option key={label} value={v === null ? '' : String(v)}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Where (optional)
        <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={200} />
      </label>
      <label>
        Notes (optional)
        <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} rows={2} />
      </label>
      <label className="inline-label">
        <input type="checkbox" checked={f.adultsOnly} onChange={(e) => setF({ ...f, adultsOnly: e.target.checked })} /> Grown-ups only (kids don’t see it)
      </label>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row">
        <button className="btn">{id === null ? 'Add to calendar' : 'Save'}</button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <span className="grow" />
        {onDelete && (
          <button type="button" className="link danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

/** The private subscription link for Google / Apple / Outlook calendar. */
function Subscribe({ active, onChange }: { active: boolean; onChange: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const confirm = useConfirm();
  const make = (): void =>
    void api<CalendarFeedLink>('/api/calendar/feed', 'POST').then((r) => {
      setLink(r.url);
      setCopied(false);
      onChange();
    });
  return (
    <div className="card" data-testid="cal-subscribe">
      <h2>Put it in Google or Apple Calendar</h2>
      <p className="small">
        A private link that adds this calendar to Google, Apple or Outlook calendar — read-only there; add and change events here in MyDay. Anyone with the link can see
        the calendar, so keep it to your household. Google can take a few hours to show changes.
      </p>
      {link ? (
        <>
          <input readOnly value={link} aria-label="Calendar link" onFocus={(e) => e.target.select()} data-testid="cal-link" />
          <div className="row">
            <button className="btn small" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
            <a className="btn small ghost" href={link.replace(/^https?:/, 'webcal:')}>
              Open in Apple Calendar
            </a>
          </div>
          <p className="small muted">
            Google Calendar (on a computer): Other calendars → <b>+</b> → From URL → paste the link. This link is shown once — make a new one any time.
          </p>
        </>
      ) : (
        <button className="btn small" onClick={make}>
          {active ? 'Make a new link (the old one stops working)' : 'Make a private link'}
        </button>
      )}
      {active && !link && (
        <button
          className="link danger small"
          onClick={() =>
            void confirm({ title: 'Turn off the calendar link?', body: 'Calendars that subscribed stop updating.', confirmLabel: 'Turn off', danger: true }).then(
              (y) => void (y && api('/api/calendar/feed', 'DELETE').then(onChange)),
            )
          }
        >
          Turn off the link
        </button>
      )}
    </div>
  );
}

/** Today's events, for the Today screens (grown-ups and kids). */
export function TodayOnCalendar() {
  const t = isoToday();
  const { data } = useLoad<CalendarResponse>(`/api/calendar?from=${t}&to=${t}`);
  if (!data || !data.occurrences.length) return null;
  return (
    <div className="card" data-testid="today-calendar">
      <h2>On the calendar today</h2>
      <ul className="plain rows">
        {data.occurrences.map((o) => (
          <li key={o.eventId}>
            <span>
              <b>{o.title}</b>
              {o.people.length > 0 && <small className="muted"> · {o.people.map((p) => p.name).join(', ')}</small>}
            </span>
            <small className="muted">{timeLabel(o)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
