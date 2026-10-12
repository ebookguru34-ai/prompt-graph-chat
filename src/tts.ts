// Local TTS via any OpenAI-compatible POST /v1/audio/speech server (Kokoro-FastAPI, KoboldCPP TTS, ...),
// always through the local proxy (/tts/* with X-TTS-Url) so phones over Tailscale work and CORS is avoided.

export type TtsBackend = 'kokoro' | 'kobold' | 'custom';
export interface TtsSettings {
  enabled: boolean; backend: TtsBackend; url: string; voice: string; model: string; speed: number;
  autoPlay: boolean; skipActions: boolean; /** Read <think>/<thinking>/<reasoning> aloud. Default OFF. */ speakThinking: boolean; format: 'mp3' | 'wav';
}
export const TTS_PRESETS: Record<TtsBackend, { label: string; url: string; model: string; voice: string; voices: string[] }> = {
  kokoro: { label: 'Kokoro-FastAPI', url: 'http://localhost:8880', model: 'kokoro', voice: 'af_heart',
    voices: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'am_onyx', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'] },
  kobold: { label: 'KoboldCPP TTS', url: 'http://localhost:5001', model: 'kcpp', voice: 'af_heart',
    voices: ['af_heart', 'af_bella', 'af_sky', 'af_nova', 'am_adam', 'am_michael', 'bf_emma', 'bm_george', 'kobo', 'cheery', 'sleepy', 'shouty', 'chatty'] },
  custom: { label: 'Custom (OpenAI-compatible)', url: 'http://localhost:8880', model: 'tts-1', voice: 'alloy', voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
};
export const DEFAULT_TTS: TtsSettings = { enabled: false, backend: 'kokoro', url: TTS_PRESETS.kokoro.url, voice: 'af_heart', model: 'kokoro',
  speed: 1, autoPlay: true, skipActions: true, speakThinking: false, format: 'mp3' };

const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi;
const THINK_CLOSE = /<\/(think|thinking|reasoning)>/i;
const THINK_TAGS = /<\/?(think|thinking|reasoning)>/gi;
/** Text actually spoken: drop <think> blocks, *actions*, markdown/code noise. */
export function cleanForSpeech(text: string, o: Pick<TtsSettings, 'skipActions' | 'speakThinking'>): string {
  let t = text;
  if (!o.speakThinking) {
    t = t.replace(THINK_BLOCK, ' ');                         // closed or unclosed (still streaming) blocks
    const orphan = t.search(THINK_CLOSE); if (orphan !== -1) t = t.slice(t.indexOf('>', orphan) + 1); // reasoning with only a closing tag
  } else t = t.replace(THINK_TAGS, ' ');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ');
  if (o.skipActions) t = t.replace(/\*[^*\n]+\*/g, ' ').replace(/\*[^*\n]*$/, ' '); // also an unfinished trailing *action
  t = t.replace(/[*_`#>~]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return t.replace(/\s+/g, ' ').trim();
}

/** Split into sentences; returns [complete sentences, remainder]. With `final`, the remainder is included. */
export function splitSentences(text: string, final = false): [string[], string] {
  const out: string[] = []; const re = /[^.!?…\n]*(?:[.!?…]+["'”’)\]]*(?=\s)|\n+)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) { const s = m[0].trim(); if (s) out.push(s); last = re.lastIndex; }
  let rest = text.slice(last);
  if (final && rest.trim()) { out.push(rest.trim()); rest = ''; }
  // merge very short fragments ("Hi." "Ok.") into the next one to avoid choppy audio
  const merged: string[] = [];
  for (const s of out) { if (merged.length && merged[merged.length - 1].length < 12) merged[merged.length - 1] += ' ' + s; else merged.push(s); }
  return [merged, rest];
}

/** Turns streamed tokens into speakable sentence chunks. Cleans the whole raw text so *actions* and
 *  <think> spanning tokens are handled, and only emits text past what was already emitted. */
export class SentenceStreamer {
  private raw = ''; private emitted = 0;
  constructor(private opts: Pick<TtsSettings, 'skipActions' | 'speakThinking'>, private emit: (s: string) => void) {}
  push(tok: string) { this.raw += tok; this.flush(false); }
  end(fullText?: string) { if (fullText != null) this.raw = fullText; this.flush(true); }
  private flush(final: boolean) {
    // While streaming, don't speak inside an unclosed <think> or *action*.
    let raw = this.raw;
    if (!final) {
      if (this.opts.skipActions && ((raw.match(/\*/g) || []).length % 2)) raw = raw.slice(0, raw.lastIndexOf('*'));
      raw = raw.replace(/<[^>]{0,12}$/, ''); // a tag still arriving (e.g. "<thin") must not be spoken
    }
    const clean = cleanForSpeech(raw, this.opts) + (final ? '' : /\s$/.test(raw) ? ' ' : '');
    if (clean.length <= this.emitted) return;
    const [sents, rest] = splitSentences(clean.slice(this.emitted), final);
    for (const s of sents) this.emit(s);
    this.emitted = clean.length - rest.length;
  }
}

export async function fetchVoices(url: string): Promise<string[]> {
  const r = await fetch('/tts/v1/audio/voices', { headers: { 'x-tts-url': url } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const arr: unknown[] = Array.isArray(j) ? j : Array.isArray(j.voices) ? j.voices : Array.isArray(j.data) ? j.data : [];
  return arr.map((v) => (typeof v === 'string' ? v : (v as Record<string, string>)?.id ?? (v as Record<string, string>)?.voice_id ?? (v as Record<string, string>)?.name)).filter((x): x is string => !!x);
}

export async function synth(s: TtsSettings, text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch('/tts/v1/audio/speech', {
    method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-tts-url': s.url },
    body: JSON.stringify({ model: s.model || TTS_PRESETS[s.backend].model, input: text, voice, response_format: s.format, speed: s.speed }),
  });
  if (!r.ok) { let m = 'TTS server returned HTTP ' + r.status; try { const j = await r.json(); m = j.message || j.detail?.message || j.detail || j.error || m; } catch { /* ignore */ } throw new Error(String(m)); }
  return r.blob();
}

type Listener = (state: { playingId: string | null; error?: string }) => void;
// A short silent WAV used to unlock audio on mobile inside a user gesture.
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

/** Sequential player: queue sentence chunks, synthesize ahead (1 prefetch), play in order on one <audio>. */
export class TtsPlayer {
  private audio: HTMLAudioElement | null = null;
  private queue: { text: string; blob?: Promise<Blob> }[] = [];
  private playing = false; private gen = 0; private ac = new AbortController();
  private ended = true;
  playingId: string | null = null;
  constructor(private get: () => { s: TtsSettings; voice: string }, private onState: Listener = () => {}, private synthFn = synth) {}
  private el() { if (!this.audio) { this.audio = new Audio(); this.audio.preload = 'auto'; } return this.audio; }
  /** Call from a tap/click handler (e.g. Send) so mobile browsers allow later playback. */
  unlock() { const a = this.el(); if (a.dataset.unlocked) return; a.src = SILENT; a.play().then(() => { a.dataset.unlocked = '1'; }).catch(() => { /* ignore */ }); }
  /** Start a new utterance for message `id` (stops anything playing). */
  begin(id: string) { this.stop(); this.playingId = id; this.ended = false; this.onState({ playingId: id }); }
  enqueue(text: string) {
    if (!text.trim() || !this.playingId) return;
    this.queue.push({ text });
    this.prefetch(); if (!this.playing) void this.loop(this.gen);
  }
  /** No more chunks for this utterance; state goes idle when the queue drains. */
  finish() { this.ended = true; if (!this.playing && !this.queue.length) this.idle(); }
  speak(id: string, chunks: string[]) { this.begin(id); for (const c of chunks) this.enqueue(c); this.finish(); }
  stop() {
    this.gen++; this.ac.abort(); this.ac = new AbortController(); this.queue = []; this.playing = false; this.ended = true;
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); }
    if (this.playingId) { this.playingId = null; this.onState({ playingId: null }); }
  }
  private idle() { this.playingId = null; this.onState({ playingId: null }); }
  private prefetch() {
    const { s, voice } = this.get();
    for (const q of this.queue.slice(0, 2)) if (!q.blob) { q.blob = this.synthFn(s, q.text, voice, this.ac.signal); q.blob.catch(() => { /* handled in loop */ }); }
  }
  private async loop(gen: number) {
    this.playing = true;
    while (this.queue.length && gen === this.gen) {
      this.prefetch();
      const q = this.queue[0];
      try {
        const blob = await q.blob!; if (gen !== this.gen) return;
        this.queue.shift(); this.prefetch();
        await this.play(blob, gen);
      } catch (e) {
        if (gen !== this.gen) return;
        this.stop(); this.onState({ playingId: null, error: (e as Error).message }); return;
      }
    }
    if (gen !== this.gen) return;
    this.playing = false;
    if (this.ended) this.idle();
  }
  private play(blob: Blob, gen: number) {
    return new Promise<void>((ok, bad) => {
      const a = this.el(); const url = URL.createObjectURL(blob);
      const done = () => { URL.revokeObjectURL(url); a.onended = a.onerror = null; ok(); };
      a.onended = done; a.onerror = () => { URL.revokeObjectURL(url); bad(new Error('Could not play TTS audio')); };
      a.src = url; a.play().catch((e: Error) => { URL.revokeObjectURL(url); if (gen !== this.gen) ok(); else bad(new Error(e.name === 'NotAllowedError' ? 'Browser blocked audio: tap the speaker button once to allow playback.' : e.message)); });
    });
  }
}
