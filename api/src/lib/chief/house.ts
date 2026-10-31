/**
 * JP3, the house itself (migrations/064_house.sql) — and storm mode.
 *
 * The family's own Home Assistant is read for the things a chief of staff watches: the alarm,
 * locks, thermostat, lights, the garage, doors and windows. Reads are T0. A pending or triggered
 * alarm is a Jarvis catch — said at once, through quiet hours — not an email nobody reads.
 * Control is T2: one command a parent approves, run once. She never unlocks, opens or disarms;
 * those stay in the family's own hands (and their alarm company's).
 *
 * Storm mode: severe weather for the place a parent opted in (National Weather Service alerts)
 * re-plans the evening — who's out during it, the pickups that fall inside it, what's open at the
 * house, and the shelter steps for that kind of storm. She prepares; the parents decide.
 */
import type { DateStr, HomeDevice, HouseStatus, HouseholdMember, StormPlan } from '@myday/shared';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { addDays, localToInstant, today } from '../dates.js';
import { HttpError } from '../http.js';
import { publicUrl } from '../robot.js';
import { currentKeyId, openText, sealText } from '../seal.js';
import { SOURCE } from './facts.js';
import type { Viewer } from './scope.js';
import { scheduleFor } from './tools.js';

export const HOUSE_SOURCE = SOURCE.house;
const STALE_MS = 60 * 60_000;

export const requireParentHouse = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'The house is for grown-ups');
};

/** "9:14 PM" and the hour, in the household's time zone. */
const clock = (d: Date): string => d.toLocaleTimeString('en-US', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' });
const localHour = (d: Date): number => Number(new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hour: 'numeric', hourCycle: 'h23' }).format(d));

/* ---------- Home Assistant ---------- */

interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

/** Which Home Assistant entities matter here, and what kind they are. */
function kindOf(s: HaState): HomeDevice['kind'] | null {
  const [domain] = s.entity_id.split('.');
  const dc = String(s.attributes?.device_class ?? '');
  if (domain === 'alarm_control_panel') return 'alarm';
  if (domain === 'lock') return 'lock';
  if (domain === 'climate') return 'thermostat';
  if (domain === 'light') return 'light';
  if (domain === 'cover' && (dc === 'garage' || /garage/i.test(s.entity_id))) return 'garage';
  if (domain === 'binary_sensor' && (dc === 'garage_door' || dc === 'garage')) return 'garage';
  if (domain === 'binary_sensor' && dc === 'door') return 'door';
  if (domain === 'binary_sensor' && dc === 'window') return 'window';
  return null;
}

async function connection(): Promise<{ base: string; token: string; lastSynced: Date | null; lastError: string | null } | null> {
  const { rows } = await pool.query<{ base_url: string; token_enc: Buffer; key_id: string; last_synced_at: Date | null; last_error: string | null }>(
    'SELECT base_url, token_enc, key_id, last_synced_at, last_error FROM home_connections LIMIT 1',
  );
  const r = rows[0];
  return r ? { base: r.base_url, token: openText(r.token_enc, r.key_id), lastSynced: r.last_synced_at, lastError: r.last_error } : null;
}

async function ha(base: string, token: string, path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
  if (!(await publicUrl(url))) throw new HttpError(400, 'That Home Assistant address isn’t reachable from the internet — use its remote (https) address, e.g. your Nabu Casa URL');
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Home Assistant said no — the access token may have been revoked. Make a new long-lived token.');
  if (!res.ok) throw new HttpError(502, `Home Assistant didn’t answer (${res.status})`);
  return res.json();
}

/** Connect (or replace) the family's Home Assistant — it must answer before it's saved. */
export async function connectHouse(me: HouseholdMember, baseUrl: string, token: string): Promise<void> {
  requireParentHouse(me);
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    throw new HttpError(400, 'Paste your Home Assistant address, like https://yourhome.ui.nabu.casa');
  }
  if (u.username || u.password) throw new HttpError(400, 'Leave the login out of the address — the token is the login');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const states = await ha(base, token.trim(), 'api/states');
  if (!Array.isArray(states)) throw new HttpError(400, 'That doesn’t look like Home Assistant');
  const keyId = currentKeyId();
  await pool.query('DELETE FROM home_connections');
  await pool.query("INSERT INTO home_connections (provider, base_url, token_enc, key_id, created_by) VALUES ('home_assistant', $1, $2, $3, $4)", [base, sealText(token.trim(), keyId), keyId, me.id]);
  await syncHouse();
}

export async function disconnectHouse(me: HouseholdMember): Promise<void> {
  requireParentHouse(me);
  await pool.query('DELETE FROM home_connections');
  await pool.query('DELETE FROM home_devices');
}

/** Read every device that matters; keep when each last changed. */
export async function syncHouse(): Promise<void> {
  const c = await connection();
  if (!c) return;
  try {
    const states = (await ha(c.base, c.token, 'api/states')) as HaState[];
    const seen: string[] = [];
    for (const s of states) {
      const kind = kindOf(s);
      if (!kind) continue;
      seen.push(s.entity_id);
      const name = String(s.attributes?.friendly_name ?? s.entity_id);
      const changed = s.last_changed ? new Date(s.last_changed) : new Date();
      await pool.query(
        `INSERT INTO home_devices (entity_id, kind, name, state, attrs, changed_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (household_id, entity_id) DO UPDATE SET kind = $2, name = $3, state = $4, attrs = $5,
           changed_at = CASE WHEN home_devices.state = $4 THEN home_devices.changed_at ELSE $6 END, updated_at = now()`,
        [s.entity_id, kind, name, s.state, JSON.stringify(s.attributes ?? {}), changed],
      );
    }
    await pool.query('DELETE FROM home_devices WHERE NOT (entity_id = ANY($1))', [seen]);
    await pool.query('UPDATE home_connections SET last_synced_at = $1, last_error = NULL', [new Date()]);
  } catch (e) {
    await pool.query('UPDATE home_connections SET last_error = $1', [e instanceof Error ? e.message : 'Unreachable']);
  }
}

/** Plain words for one device's state. */
function said(d: { kind: HomeDevice['kind']; state: string; attrs: Record<string, unknown> }): string {
  switch (d.kind) {
    case 'alarm':
      return { disarmed: 'off (disarmed)', armed_home: 'armed (home)', armed_away: 'armed (away)', armed_night: 'armed (night)', arming: 'arming', pending: 'COUNTING DOWN (pending)', triggered: 'GOING OFF (triggered)' }[d.state] ?? d.state;
    case 'lock':
      return d.state === 'jammed' ? 'JAMMED' : d.state;
    case 'thermostat': {
      const cur = d.attrs.current_temperature;
      const set = d.attrs.temperature;
      return `${d.state}${cur !== undefined ? `, ${cur}° now` : ''}${set !== undefined && set !== null ? `, set to ${set}°` : ''}`;
    }
    case 'garage':
      return d.state === 'on' ? 'open' : d.state === 'off' ? 'closed' : d.state;
    case 'door':
    case 'window':
      return d.state === 'on' ? 'open' : d.state === 'off' ? 'closed' : d.state;
    default:
      return d.state;
  }
}
const isOpen = (d: { kind: HomeDevice['kind']; state: string }): boolean => (d.kind === 'garage' || d.kind === 'door' || d.kind === 'window') && (d.state === 'open' || d.state === 'opening' || d.state === 'on');

export async function houseStatus(): Promise<HouseStatus> {
  const c = await connection();
  if (!c) return { connected: false, devices: [], asOf: null, stale: null, source: HOUSE_SOURCE };
  if (!c.lastSynced || Date.now() - c.lastSynced.getTime() > 2 * 60_000) await syncHouse();
  const fresh = await connection();
  const { rows } = await pool.query<{ id: number; entity_id: string; kind: HomeDevice['kind']; name: string; state: string; attrs: Record<string, unknown>; changed_at: Date }>(
    "SELECT id, entity_id, kind, name, state, attrs, changed_at FROM home_devices ORDER BY array_position(ARRAY['alarm','lock','garage','door','window','thermostat','light'], kind), name",
  );
  const at = fresh?.lastSynced ?? null;
  const stale = fresh?.lastError
    ? `Hana can’t read the house right now (${fresh.lastError})${at ? ` — last read ${clock(at)}` : ''}.`
    : at && Date.now() - at.getTime() > STALE_MS
      ? `Last read ${clock(at)} — it may have changed since.`
      : null;
  return {
    connected: true,
    devices: rows.map((r) => ({ id: r.id, entityId: r.entity_id, kind: r.kind, name: r.name, state: r.state, said: said(r), open: isOpen(r), changedAt: r.changed_at.toISOString() })),
    asOf: at?.toISOString() ?? null,
    stale,
    source: HOUSE_SOURCE,
  };
}

/** What Hana may ask the house to do — never unlock, open or disarm. */
export const HOUSE_ACTIONS = ['lock', 'close', 'set_temperature', 'turn_on', 'turn_off'] as const;
export type HouseAction = (typeof HOUSE_ACTIONS)[number];
const SERVICE: Record<HouseAction, Partial<Record<HomeDevice['kind'], [string, string]>>> = {
  lock: { lock: ['lock', 'lock'] },
  close: { garage: ['cover', 'close_cover'] },
  set_temperature: { thermostat: ['climate', 'set_temperature'] },
  turn_on: { light: ['light', 'turn_on'] },
  turn_off: { light: ['light', 'turn_off'] },
};

export async function deviceByName(name: string): Promise<{ entityId: string; kind: HomeDevice['kind']; name: string; state: string }> {
  const q = name.trim().toLowerCase();
  const { rows } = await pool.query<{ entity_id: string; kind: HomeDevice['kind']; name: string; state: string }>('SELECT entity_id, kind, name, state FROM home_devices');
  const hit = rows.filter((r) => r.name.toLowerCase() === q || r.entity_id === q);
  const pick = hit.length ? hit : rows.filter((r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase()) || q.includes(r.kind));
  if (pick.length !== 1) throw new HttpError(pick.length ? 409 : 404, pick.length ? `Which one — ${pick.map((r) => r.name).join(', ')}?` : `There’s nothing called “${name}” in the house`);
  const d = pick[0] as { entity_id: string; kind: HomeDevice['kind']; name: string; state: string };
  return { entityId: d.entity_id, kind: d.kind, name: d.name, state: d.state };
}

/** Check a command before it becomes a proposal: the device exists and the action fits it. */
export async function planCommand(name: string, action: HouseAction, value: number | null): Promise<{ entityId: string; name: string; service: [string, string] }> {
  const d = await deviceByName(name);
  const service = SERVICE[action][d.kind];
  if (!service) throw new HttpError(400, `Hana can’t ${action.replace('_', ' ')} the ${d.name} (${d.kind}). She never unlocks, opens or disarms.`);
  if (action === 'set_temperature' && (value === null || value < 45 || value > 90)) throw new HttpError(400, 'Pick a temperature between 45° and 90°');
  return { entityId: d.entityId, name: d.name, service };
}

/** Run one approved command, then read the house back and say what it reports. */
export async function runCommand(me: HouseholdMember, name: string, action: HouseAction, value: number | null): Promise<string> {
  requireParentHouse(me);
  const c = await connection();
  if (!c) throw new HttpError(400, 'The house isn’t connected');
  const p = await planCommand(name, action, value);
  await ha(c.base, c.token, `api/services/${p.service[0]}/${p.service[1]}`, { entity_id: p.entityId, ...(action === 'set_temperature' ? { temperature: value } : {}) });
  await syncHouse();
  const { rows } = await pool.query<{ kind: HomeDevice['kind']; state: string; attrs: Record<string, unknown> }>('SELECT kind, state, attrs FROM home_devices WHERE entity_id = $1', [p.entityId]);
  return `Sent to the house: ${action.replace('_', ' ')} ${p.name}${action === 'set_temperature' ? ` to ${value}°` : ''}. It now reports: ${rows[0] ? said(rows[0]) : 'no reading'}.`;
}

/** The watch: the alarm at once (through quiet hours); open or unlocked at night; a jam; losing the house. */
export async function houseWatch(parents: HouseholdMember[], now: Date = new Date()): Promise<Array<{ key: string; category: 'house'; text: string; sameDay: boolean; subjectId: null; source: string; asOf: string; once: true }>> {
  if (!parents.length || !(await connection())) return [];
  await syncHouse();
  const s = await houseStatus();
  const out: Array<{ key: string; category: 'house'; text: string; sameDay: boolean; subjectId: null; source: string; asOf: string; once: true }> = [];
  const base = { category: 'house' as const, subjectId: null, source: HOUSE_SOURCE, asOf: s.asOf ?? now.toISOString(), once: true as const };
  const night = localHour(now) >= 21 || localHour(now) < 6;
  const day = today(now);
  for (const d of s.devices) {
    if (d.kind === 'alarm' && (d.state === 'triggered' || d.state === 'pending')) {
      out.push({
        ...base,
        key: `house:alarm:${d.entityId}:${d.state}:${d.changedAt}`,
        sameDay: true,
        text:
          d.state === 'triggered'
            ? `The ${d.name} is going off (since ${clock(new Date(d.changedAt))}). If you’re not sure why, call your alarm company or 911. Hana can’t disarm it.`
            : `The ${d.name} is counting down (since ${clock(new Date(d.changedAt))}) — a door opened while it was armed. If that wasn’t someone in the family, call your alarm company or 911.`,
      });
    }
    if (d.kind === 'lock' && d.state === 'jammed') out.push({ ...base, key: `house:jam:${d.entityId}:${d.changedAt}`, sameDay: false, text: `The ${d.name} lock says it’s jammed (since ${clock(new Date(d.changedAt))}).` });
    const atNight = night && ((d.kind === 'garage' && d.open) || (d.kind === 'lock' && d.state === 'unlocked'));
    if (atNight) {
      const action = d.kind === 'garage' ? 'close' : 'lock';
      // Q10 (T3): with "Lock up at night" granted, she does it — on the granting parent's authority — and says so.
      const done = await lockUp(d.name, action, now);
      out.push({
        ...base,
        key: `house:night:${d.entityId}:${day}`,
        sameDay: false,
        text:
          done ??
          (d.kind === 'garage'
            ? `The ${d.name} is still open at ${clock(now)}. Want me to close it? I’ll only do it on your OK.`
            : `The ${d.name} is unlocked at ${clock(now)}. Want me to lock it? I’ll only do it on your OK.`),
      });
    }
  }
  if (s.stale && /can’t read/.test(s.stale)) out.push({ ...base, key: `house:down:${day}`, sameDay: false, text: s.stale });
  return out;
}

/** The "Lock up at night" class: run the one command, log it as T3, and return what to tell the parents (null = not granted). */
async function lockUp(name: string, action: 'lock' | 'close', now: Date): Promise<string | null> {
  const { activeGrant, covers, logExercise } = await import('./standing.js');
  if (!(await covers('house_control', { action }, null))) return null;
  const g = await activeGrant('lock_up_at_night');
  const { rows } = await pool.query<{ id: number; name: string; kind: 'adult' | 'kid' }>("SELECT id, name, kind FROM household_members WHERE id = $1 AND kind = 'adult' AND archived_at IS NULL", [g?.granted_by ?? 0]);
  const grantor = rows[0];
  if (!grantor) return null;
  const input = { device: name, action, value: null };
  const summary = `House: ${action} ${name}`;
  try {
    const res = await runCommand({ id: grantor.id, name: grantor.name, kind: 'adult', key: '', age: null }, name, action, null);
    await logExercise(grantor.id, 'house_control', input, 'lock_up_at_night', summary, 'done', res);
    return `${action === 'lock' ? 'I locked' : 'I closed'} the ${name} at ${clock(now)} under your standing OK (“Lock up at night”). ${res.replace(/^Sent to the house: [^.]*\. /, '')} Revoke it any time in Settings.`;
  } catch (e) {
    const why = e instanceof HttpError ? e.message : 'the house didn’t answer';
    await logExercise(grantor.id, 'house_control', input, 'lock_up_at_night', summary, 'failed', why);
    return `I tried to ${action} the ${name} at ${clock(now)} under your standing OK, and it didn’t work (${why}). It’s still ${action === 'lock' ? 'unlocked' : 'open'}.`;
  }
}

/* ---------- storm mode ---------- */

const UA = 'MyDay family assistant (support@conquermyday.app)';
const STORM = /\b(tornado|severe thunderstorm|flash flood|flood|hurricane|tropical storm|blizzard|winter storm|ice storm|extreme wind|high wind|extreme cold|excessive heat|extreme heat|dust storm|storm surge)\b/i;
const SHELTER: Array<[RegExp, string[]]> = [
  [/tornado/i, ['Go to the lowest floor, an inside room with no windows (a basement, bathroom or closet).', 'Bring phones, shoes and a flashlight; cover heads and necks.', 'Stay off the roads — a car is not a safe place in a tornado.']],
  [/hurricane|tropical storm|storm surge/i, ['Follow local evacuation orders first.', 'Charge phones and gather medicines, documents and water.', 'Stay inside, away from windows, until the all-clear.']],
  [/flood/i, ['Never drive or walk through water on a road — turn around, don’t drown.', 'Move to higher ground if you’re told to.', 'Keep phones charged and the car fueled.']],
  [/blizzard|winter storm|ice storm|extreme cold/i, ['Stay off the roads if you can; if you must drive, keep a blanket, water and a charger in the car.', 'Keep phones charged and flashlights handy in case the power goes.', 'Bring pets in.']],
  [/heat/i, ['Stay inside in the cool during the hottest hours; drink water often.', 'Never leave anyone — or a pet — in a parked car.', 'Check on anyone older or unwell.']],
  [/thunderstorm|wind|dust/i, ['Stay indoors and away from windows until it passes.', 'Postpone outdoor practices and games — when thunder roars, go indoors.', 'Bring in or tie down anything loose outside.']],
];

export async function setPlace(me: HouseholdMember, lat: number, lon: number, label: string, weatherOn: boolean): Promise<void> {
  requireParentHouse(me);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new HttpError(400, 'That isn’t a place on the map');
  // Rounded to about a kilometre — that's all that goes to the weather service.
  await pool.query(
    `INSERT INTO household_places (label, lat, lon, weather_on, set_by, updated_at) VALUES ($1, round($2::numeric, 2), round($3::numeric, 2), $4, $5, now())
     ON CONFLICT (household_id) DO UPDATE SET label = $1, lat = round($2::numeric, 2), lon = round($3::numeric, 2), weather_on = $4, set_by = $5, updated_at = now()`,
    [label.slice(0, 60) || 'Home', lat, lon, weatherOn, me.id],
  );
  if (!weatherOn) await pool.query('DELETE FROM weather_alerts');
  else await syncWeather();
}

export async function place(): Promise<{ label: string; lat: number; lon: number; weatherOn: boolean } | null> {
  const { rows } = await pool.query<{ label: string; lat: string; lon: string; weather_on: boolean }>('SELECT label, lat, lon, weather_on FROM household_places LIMIT 1');
  const r = rows[0];
  return r ? { label: r.label, lat: Number(r.lat), lon: Number(r.lon), weatherOn: r.weather_on } : null;
}

/** The active alerts for the family's place (NWS; US). Only the rounded coordinates leave MyDay. */
export async function syncWeather(): Promise<void> {
  const p = await place();
  if (!p?.weatherOn) return;
  const base = (process.env.WEATHER_URL || 'https://api.weather.gov').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/alerts/active?point=${p.lat},${p.lon}`, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const j = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown> }> };
    const ids: string[] = [];
    for (const f of j.features ?? []) {
      const x = f.properties ?? {};
      const id = String(x.id ?? '');
      if (!id) continue;
      ids.push(id);
      const when = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
      await pool.query(
        `INSERT INTO weather_alerts (alert_id, event, severity, headline, instruction, onset, ends, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (household_id, alert_id) DO UPDATE SET event = $2, severity = $3, headline = $4, instruction = $5, onset = $6, ends = $7, fetched_at = now()`,
        [id, String(x.event ?? ''), String(x.severity ?? ''), String(x.headline ?? '').slice(0, 300), String(x.instruction ?? '').slice(0, 1500), when(x.onset) ?? when(x.effective), when(x.ends) ?? when(x.expires)],
      );
    }
    await pool.query('DELETE FROM weather_alerts WHERE NOT (alert_id = ANY($1))', [ids]);
  } catch (e) {
    console.error('weather: unavailable', e instanceof Error ? e.message : e);
  }
}

/** Storm mode: the severe alerts that touch the rest of today, and the evening re-planned around them. */
export async function stormPlan(v: Viewer, now: Date = new Date()): Promise<StormPlan | null> {
  const { rows } = await pool.query<{ alert_id: string; event: string; severity: string; headline: string; instruction: string; onset: Date | null; ends: Date | null }>(
    "SELECT alert_id, event, severity, headline, instruction, onset, ends FROM weather_alerts WHERE severity IN ('Severe', 'Extreme') ORDER BY onset NULLS FIRST",
  );
  const t = today(now);
  const endOfDay = new Date(new Date(`${addDays(t, 1)}T00:00:00Z`).getTime() + 12 * 3_600_000); // through the night
  const live = rows.filter((a) => STORM.test(a.event) && (!a.ends || a.ends > now) && (!a.onset || a.onset < endOfDay));
  if (!live.length) return null;
  const a = live.find((x) => /warning/i.test(x.event)) ?? (live[0] as (typeof live)[number]);
  const from = a.onset && a.onset > now ? a.onset : now;
  const to = a.ends ?? endOfDay;
  const window = `${clock(from)}${a.ends ? `–${clock(a.ends)}` : ' on'}`;
  // Who's out during it, and the pickups that fall inside it (from the calendar — MyDay has no presence data).
  const events = [...(await scheduleFor(v, t, t)).data, ...(to.toISOString().slice(0, 10) > t ? (await scheduleFor(v, addDays(t, 1) as DateStr, addDays(t, 1) as DateStr)).data : [])].filter((e) => !e.busy && e.time);
  const overlapping = events.filter((e) => {
    const s = localToInstant(e.date, (e.time as string).slice(0, 5));
    const en = e.endTime ? localToInstant(e.date, e.endTime.slice(0, 5)) : new Date(s.getTime() + 60 * 60_000);
    return s < to && en > from;
  });
  const out = overlapping.map((e) => ({
    title: e.title,
    time: clock(localToInstant(e.date, (e.time as string).slice(0, 5))),
    people: e.people,
    pickup: e.pickup ? (e.pickupBy ? `${e.pickupBy} is on the pickup` : 'nobody is on the pickup yet') : null,
  }));
  const steps = SHELTER.find(([re]) => re.test(a.event))?.[1] ?? ['Follow the instructions in the alert.'];
  const house = v.parent ? (await houseStatus()).devices.filter((d) => d.open || (d.kind === 'lock' && d.state === 'unlocked')).map((d) => `${d.name} is ${d.said}`) : [];
  // JP4: who's home — only the people who share their location with this viewer.
  const { seenBy } = await import('./location.js');
  const whereabouts = v.parent ? (await seenBy(v.me, now)).filter((s) => s.at).map((s) => `${s.member}: ${s.where} (${s.ago})`) : [];
  return {
    key: `storm:${a.alert_id}`,
    event: a.event,
    severity: a.severity,
    window,
    headline: a.headline,
    instruction: a.instruction,
    out,
    decisions: out.filter((e) => e.pickup).map((e) => `${e.title} at ${e.time} is inside the ${a.event.toLowerCase()} — ${e.pickup}. Cancel, move it, or keep everyone home?`),
    house,
    whereabouts,
    steps,
    source: 'National Weather Service alert for your area + MyDay calendar',
    asOf: now.toISOString(),
  };
}

export function stormLines(p: StormPlan, parent: boolean): string[] {
  return [
    `Storm mode: ${p.event} ${p.window}. ${p.steps[0]}`,
    ...(parent ? p.decisions : []),
    ...(parent && p.out.length && !p.decisions.length ? [`Out during it: ${p.out.map((e) => `${e.title} at ${e.time}`).join('; ')}.`] : []),
    ...(parent && p.house.length ? [`At the house: ${p.house.join('; ')}.`] : []),
    ...(parent && p.whereabouts.length ? [`Where everyone is (shared location): ${p.whereabouts.join('; ')}.`] : []),
  ];
}

export async function stormWatch(parents: HouseholdMember[], members: HouseholdMember[], now: Date = new Date()): Promise<Array<{ key: string; category: 'storm'; text: string; sameDay: boolean; to?: number[]; subjectId: null; source: string; asOf: string; once: true }>> {
  if (!(await place())?.weatherOn) return [];
  await syncWeather();
  const p = parents[0];
  if (!p) return [];
  const plan = await stormPlan({ me: p, parent: true }, now);
  if (!plan) return [];
  const urgent = /tornado warning|flash flood warning|hurricane warning|extreme wind warning/i.test(plan.event);
  const kids = members.filter((m) => m.kind === 'kid').map((m) => m.id);
  return [
    { key: plan.key, category: 'storm', text: stormLines(plan, true).join(' '), sameDay: urgent, subjectId: null, source: plan.source, asOf: plan.asOf, once: true },
    // Kids get the shelter steps only — never the house.
    ...(urgent && kids.length ? [{ key: `${plan.key}:kids`, category: 'storm' as const, text: `${plan.event} ${plan.window}: ${plan.steps.join(' ')}`, sameDay: true, to: kids, subjectId: null, source: plan.source, asOf: plan.asOf, once: true as const }] : []),
  ];
}

/* ---------- JP4: the forecast, for the timeline (NWS; the opted-in place only) ---------- */

interface Period {
  startTime: string;
  endTime: string;
  name?: string;
  isDaytime?: boolean;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null };
}

/** Read the forecast at most hourly. Only a forecast address on the weather service itself is followed. */
export async function syncForecast(): Promise<void> {
  const p = await place();
  if (!p?.weatherOn) return;
  const { rows } = await pool.query<{ fetched_at: Date }>('SELECT fetched_at FROM weather_forecasts LIMIT 1');
  if (rows[0] && Date.now() - rows[0].fetched_at.getTime() < 60 * 60_000) return;
  const base = (process.env.WEATHER_URL || 'https://api.weather.gov').replace(/\/+$/, '');
  const get = async (url: string): Promise<Record<string, unknown> | null> => {
    if (!url.startsWith(`${new URL(base).origin}/`)) return null;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  };
  try {
    const pt = (await get(`${base}/points/${p.lat},${p.lon}`))?.properties as { forecast?: string; forecastHourly?: string } | undefined;
    if (!pt?.forecast || !pt.forecastHourly) return;
    const periods = async (url: string): Promise<Period[]> => (((await get(url))?.properties as { periods?: Period[] } | undefined)?.periods ?? []).slice(0, 200);
    const hourly = await periods(pt.forecastHourly);
    const daily = await periods(pt.forecast);
    await pool.query(
      `INSERT INTO weather_forecasts (hourly, daily, fetched_at) VALUES ($1, $2, $3)
       ON CONFLICT (household_id) DO UPDATE SET hourly = $1, daily = $2, fetched_at = $3`,
      [JSON.stringify(hourly), JSON.stringify(daily), new Date()],
    );
  } catch (e) {
    console.error('forecast: unavailable', e instanceof Error ? e.message : e);
  }
}

const rain = (x: Period): string => (x.probabilityOfPrecipitation?.value ? `, ${x.probabilityOfPrecipitation.value}% chance of rain` : '');

/** The forecast for the timeline: one line per day, and the hour each timed event starts. */
export async function forecast(): Promise<{ daily: Map<string, string>; at: (when: Date) => string | null } | null> {
  if (!(await place())?.weatherOn) return null;
  await syncForecast();
  const { rows } = await pool.query<{ hourly: Period[]; daily: Period[] }>('SELECT hourly, daily FROM weather_forecasts LIMIT 1');
  const r = rows[0];
  if (!r) return null;
  const daily = new Map<string, string>();
  for (const x of r.daily.filter((d) => d.isDaytime !== false)) {
    const day = today(new Date(x.startTime));
    if (!daily.has(day)) daily.set(day, `${x.shortForecast}, high ${x.temperature}°${x.temperatureUnit}${rain(x)}`);
  }
  return {
    daily,
    at: (when) => {
      const h = r.hourly.find((x) => new Date(x.startTime) <= when && when < new Date(x.endTime));
      return h ? `${h.temperature}°${h.temperatureUnit}, ${h.shortForecast.toLowerCase()}${rain(h)}` : null;
    },
  };
}
