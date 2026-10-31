/**
 * JP3 in Family HQ: the house (the family's Home Assistant — read here; a change only when a
 * parent approves Hana's one command) and storm mode (weather for the place a parent opts in).
 */
import { useState, type FormEvent } from 'react';
import type { HouseStatus, StormPlan } from '@myday/shared';
import { api, useLoad } from '../../api';

interface HouseView {
  status: HouseStatus;
  place: { label: string; lat: number; lon: number; weatherOn: boolean } | null;
  storm: StormPlan | null;
}

export function HouseCard() {
  const { data, reload } = useLoad<HouseView>('/api/house');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [where, setWhere] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const run = async (p: Promise<unknown>): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      await p;
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work');
    } finally {
      setBusy(false);
    }
  };
  const connect = (e: FormEvent): void => {
    e.preventDefault();
    void run(api('/api/house/connect', 'POST', { url: url.trim(), token: token.trim() })).then(() => setToken(''));
  };
  const savePlace = (lat: number, lon: number): void => void run(api('/api/house/place', 'PUT', { lat, lon, label: 'Home', weatherOn: true }));
  const typed = (e: FormEvent): void => {
    e.preventDefault();
    const m = where.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) {
      setErr('Type it as latitude, longitude — e.g. 39.10, -94.58');
      return;
    }
    savePlace(Number(m[1]), Number(m[2]));
  };
  const here = (): void => {
    if (!navigator.geolocation) {
      setErr('This device can’t share its location — type it instead');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => savePlace(p.coords.latitude, p.coords.longitude),
      () => setErr('Location wasn’t shared — type it instead'),
    );
  };
  const s = data.status;
  return (
    <div className="card house" data-testid="hq-house">
      <h2>The house</h2>
      {data.storm && (
        <div className="storm" role="alert" data-testid="storm">
          <b>
            Storm mode: {data.storm.event} {data.storm.window}
          </b>
          {data.storm.decisions.map((d) => (
            <p key={d} className="small">
              {d}
            </p>
          ))}
          {data.storm.house.length > 0 && <p className="small">At the house: {data.storm.house.join('; ')}</p>}
          <ul className="small">
            {data.storm.steps.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="muted small">{data.storm.source}</p>
        </div>
      )}
      {s.connected ? (
        <>
          {s.stale && <p className="error small">{s.stale}</p>}
          <ul className="plain rows">
            {s.devices.map((d) => (
              <li key={d.id} className={d.open || d.state === 'triggered' || d.state === 'pending' ? 'device attention' : 'device'} data-testid="house-device">
                <span>
                  <b>{d.name}</b> <span className="muted small">· {d.said}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Ask Hana to lock up, close the garage, set the thermostat or turn lights off — each one runs only when you approve it. She never unlocks, opens or disarms.
          </p>
          <button className="link danger small" onClick={() => void run(api('/api/house/connection', 'DELETE'))}>
            Disconnect the house
          </button>
        </>
      ) : (
        <form className="inline wrap" onSubmit={connect}>
          <p className="muted small">Connect your Home Assistant so Hana can watch the alarm, locks and garage. Use its remote address and a long-lived access token (Profile → Security).</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourhome.ui.nabu.casa" aria-label="Home Assistant address" />
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Long-lived access token" aria-label="Access token" autoComplete="off" />
          <button className="btn small" disabled={busy || !url.trim() || !token.trim()} data-testid="house-connect">
            Connect
          </button>
        </form>
      )}
      <h3 className="ing-head">Weather for storm mode</h3>
      {data.place?.weatherOn ? (
        <p className="small">
          Watching severe-weather alerts near {data.place.lat.toFixed(2)}, {data.place.lon.toFixed(2)} (National Weather Service, US).{' '}
          <button className="link small" onClick={() => void run(api('/api/house/place', 'PUT', { lat: data.place?.lat, lon: data.place?.lon, weatherOn: false }))}>
            Stop
          </button>
        </p>
      ) : (
        <>
          <p className="muted small">Off. Turn it on and Hana re-plans the evening when severe weather is coming. Only rounded coordinates (about a kilometre) go to the weather service.</p>
          <div className="row wrap">
            <button className="btn small ghost" onClick={here} disabled={busy}>
              Use this device’s location
            </button>
            <form className="inline" onSubmit={typed}>
              <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="39.10, -94.58" aria-label="Latitude, longitude" />
              <button className="btn small ghost" disabled={!where.trim()} data-testid="place-save">
                Save
              </button>
            </form>
          </div>
        </>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
