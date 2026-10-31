/**
 * JP1, presence: voice as a primary way to reach Hana — push-to-talk from every page, her answer
 * spoken back if this device wants that, and (on a device that opts in, like a kitchen tablet)
 * her heads-ups spoken aloud when she starts a conversation (JP7's named reasons only).
 * Activation is always deliberate: she listens only while the button is held. Never ambient.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ChatSendResponse } from '@myday/shared';
import { api } from '../api';
import { useVoice } from '../modules/chat/Chat';

const KEY = { replies: 'hana.speakReplies', headsUps: 'hana.speakHeadsUps', last: 'hana.headsUpLast' } as const;

/** Per-device choices (this browser only). Never required — the page works without storage. */
export function devicePref(key: keyof typeof KEY): string | null {
  try {
    return localStorage.getItem(KEY[key]);
  } catch {
    return null;
  }
}
export function setDevicePref(key: keyof typeof KEY, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(KEY[key]);
    else localStorage.setItem(KEY[key], value);
  } catch {
    /* private window: the choice lasts this visit only */
  }
}

export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, '').slice(0, 1200));
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

/** Hold to talk to Hana from anywhere; her reply shows here (and is spoken if this device asked). */
export function VoiceDock() {
  const [reply, setReply] = useState<{ text: string; waiting: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const voice = useVoice((text) => {
    setBusy(true);
    setErr(null);
    void api<ChatSendResponse>('/api/chat/companion', 'POST', { message: text, clientId: `voice-${Date.now().toString(36)}` })
      .then((r) => {
        const t = r.reply?.text ?? '';
        const waiting = r.actions.filter((a) => a.status === 'pending').length;
        setReply({ text: t, waiting });
        if (t && devicePref('replies') === '1') speak(t);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Hana couldn’t answer that'))
      .finally(() => setBusy(false));
  });
  if (!voice.supported) return null;
  return (
    <div className="voice-dock" data-testid="voice-dock">
      {(reply || err || voice.err) && (
        <div className="voice-bubble card" role="status" aria-live="polite" data-testid="voice-reply">
          {err || voice.err ? <p className="error small">{err ?? voice.err}</p> : <p className="small">{reply?.text}</p>}
          {reply && reply.waiting > 0 && (
            <p className="small">
              {reply.waiting} thing{reply.waiting === 1 ? '' : 's'} waiting for your OK — <Link to="/hana">open Ask Hana</Link>.
            </p>
          )}
          <button className="link small" onClick={() => (setReply(null), setErr(null))}>
            Close
          </button>
        </div>
      )}
      <button
        type="button"
        className={`voice-mic${voice.state !== 'idle' || busy ? ' on' : ''}`}
        aria-label={voice.state === 'listening' ? 'Listening — let go to stop' : busy || voice.state === 'hearing' ? 'Hana is thinking' : 'Hold to talk to Hana'}
        aria-pressed={voice.state === 'listening'}
        disabled={busy || voice.state === 'hearing'}
        onPointerDown={(e) => {
          e.preventDefault();
          voice.start();
        }}
        onPointerUp={voice.stop}
        onPointerLeave={voice.stop}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && voice.start()}
        onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && voice.stop()}
        data-testid="voice-mic"
      >
        🎙
      </button>
    </div>
  );
}

/** On a device that asked for it: speak the heads-ups Hana starts (JP7's reasons), while MyDay is open. */
export function useSpokenHeadsUps(enabled: boolean): void {
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled || devicePref('headsUps') !== '1') return;
    const check = (): void => {
      const since = Number(devicePref('last') ?? 0);
      void api<{ items: Array<{ id: number; text: string }> }>(`/api/hana/initiative/recent?since=${since}`)
        .then((r) => {
          for (const it of r.items) speak(`Hana. ${it.text}`);
          const last = r.items.at(-1);
          if (last) setDevicePref('last', String(last.id));
        })
        .catch(() => undefined);
    };
    // The first look only catches up (nothing old is read aloud).
    void api<{ items: Array<{ id: number }> }>(`/api/hana/initiative/recent?since=${Number(devicePref('last') ?? 0)}`)
      .then((r) => {
        const last = r.items.at(-1);
        if (last && !devicePref('last')) setDevicePref('last', String(last.id));
      })
      .catch(() => undefined)
      .finally(() => {
        timer.current = window.setInterval(check, 60_000);
      });
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [enabled]);
}
