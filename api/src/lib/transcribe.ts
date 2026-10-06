/**
 * Lecture audio → text. Real: any OpenAI-compatible Whisper endpoint
 * (default OpenAI's /v1/audio/transcriptions, model whisper-1), key from
 * TRANSCRIPTION_KEY. Stub (TRANSCRIPTION_STUB=1, never in production): local
 * proof — returns a canned classroom transcript, or the uploaded bytes when
 * they are text starting with "STUB-TRANSCRIPT:".
 */
import { config } from '../config.js';
import { HttpError } from './http.js';

export interface Transcriber {
  readonly kind: 'whisper' | 'stub';
  transcribe(audio: Buffer, mime: string, filename: string): Promise<string>;
}

class WhisperTranscriber implements Transcriber {
  readonly kind = 'whisper' as const;
  constructor(
    private readonly key: string,
    private readonly url: string,
    private readonly model: string,
  ) {}

  async transcribe(audio: Buffer, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
    form.append('model', this.model);
    form.append('response_format', 'text');
    const res = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: form });
    const text = await res.text();
    if (!res.ok) {
      console.error('transcription failed', res.status);
      throw new HttpError(502, 'Transcription failed — try again later');
    }
    return text.trim();
  }
}

export const STUB_LECTURE =
  'Today we are starting the unit on photosynthesis. Photosynthesis is the process plants use to turn light energy into chemical energy. ' +
  'It happens in the chloroplast, which is the part of the plant cell that contains chlorophyll. Chlorophyll is the green pigment that absorbs light. ' +
  'The inputs are carbon dioxide, water and sunlight. The outputs are glucose and oxygen. ' +
  'There are two stages. The light-dependent reactions happen in the thylakoid membranes and make ATP and NADPH. ' +
  'The Calvin cycle happens in the stroma and uses ATP and NADPH to build glucose from carbon dioxide. ' +
  'Remember that plants also do cellular respiration, so they use some of the glucose they make. ' +
  'For homework, finish worksheet 4.2 on the two stages, due Friday. Also read pages 112 to 118 before the quiz next Tuesday.';

/** Tests: audio starting with this fails the first time (like an outage), then transcribes. */
const FAIL_ONCE = 'STUB-FAIL-ONCE:';
const failedOnce = new Set<string>();

class StubTranscriber implements Transcriber {
  readonly kind = 'stub' as const;
  async transcribe(audio: Buffer): Promise<string> {
    let text = audio.toString('utf8');
    if (text.startsWith(FAIL_ONCE)) {
      if (!failedOnce.has(text)) {
        failedOnce.add(text);
        throw new HttpError(502, 'Transcription failed — try again later');
      }
      text = `STUB-TRANSCRIPT:${text.slice(FAIL_ONCE.length)}`;
    }
    return text.startsWith('STUB-TRANSCRIPT:') ? text.slice('STUB-TRANSCRIPT:'.length).trim() : STUB_LECTURE;
  }
}

let cached: Transcriber | null | undefined;

export function transcriber(): Transcriber | null {
  if (cached !== undefined) return cached;
  const key = process.env.TRANSCRIPTION_KEY ?? '';
  if (key) {
    cached = new WhisperTranscriber(
      key,
      process.env.TRANSCRIPTION_URL || 'https://api.openai.com/v1/audio/transcriptions',
      process.env.TRANSCRIPTION_MODEL || 'whisper-1',
    );
  } else if (process.env.TRANSCRIPTION_STUB === '1' && !config.production) {
    cached = new StubTranscriber();
  } else {
    cached = null;
  }
  return cached;
}
