import { useState } from 'react';
import { TTS_PRESETS, fetchVoices, type TtsBackend, type TtsSettings } from './tts';

interface Props { tts: TtsSettings; setTts: (f: (t: TtsSettings) => TtsSettings) => void; onTest: () => void; testing: boolean; charVoice?: string; charName?: string; }

export function TtsPanel({ tts, setTts, onTest, testing, charVoice, charName }: Props) {
  const [voices, setVoices] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const set = <K extends keyof TtsSettings>(k: K, v: TtsSettings[K]) => setTts((t) => ({ ...t, [k]: v }));
  const preset = TTS_PRESETS[tts.backend];
  const list = Array.from(new Set([...(voices.length ? voices : preset.voices), tts.voice].filter(Boolean)));
  async function load() {
    setMsg('Loading voices…');
    try { const v = await fetchVoices(tts.url); setVoices(v); setMsg(v.length ? `✅ ${v.length} voices from server` : 'Server returned no voices; type one below.'); }
    catch (e) { setVoices([]); setMsg('❌ Could not list voices (' + (e as Error).message + '). Using the built-in list; you can type any voice name.'); }
  }
  return (
    <section className="tts">
      <h4>Text-to-speech</h4>
      <label className="check"><input type="checkbox" checked={tts.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enable TTS</label>
      <label className="field col"><span>Backend</span>
        <select value={tts.backend} onChange={(e) => { const b = e.target.value as TtsBackend; const p = TTS_PRESETS[b];
          setTts((t) => ({ ...t, backend: b, url: p.url, model: p.model, voice: p.voice })); setVoices([]); setMsg(''); }}>
          {(Object.keys(TTS_PRESETS) as TtsBackend[]).map((k) => <option key={k} value={k}>{TTS_PRESETS[k].label}</option>)}</select></label>
      <label className="field col"><span>TTS server URL (as seen from the PC running the app)</span>
        <input value={tts.url} onChange={(e) => set('url', e.target.value)} placeholder={preset.url} /></label>
      {tts.backend === 'custom' && <label className="field col"><span>Model</span><input value={tts.model} onChange={(e) => set('model', e.target.value)} /></label>}
      <label className="field col"><span>Voice</span>
        <div className="row">
          <select value={tts.voice} onChange={(e) => set('voice', e.target.value)}>{list.map((v) => <option key={v}>{v}</option>)}</select>
          <button onClick={load} title="Fetch voices from the server (GET /v1/audio/voices)">↻</button>
        </div>
        <input value={tts.voice} onChange={(e) => set('voice', e.target.value)} placeholder="or type a voice name" /></label>
      {msg && <div className={msg.startsWith('❌') ? 'error' : 'muted'}>{msg}</div>}
      {charName && <div className="muted">Character "{charName}" {charVoice ? <>uses its own voice: <b>{charVoice}</b></> : 'uses this voice (no override set)'}.</div>}
      <label className="field"><span>Speed {tts.speed.toFixed(2)}×</span>
        <input type="range" min={0.5} max={2} step={0.05} value={tts.speed} onChange={(e) => set('speed', Number(e.target.value))} /></label>
      <label className="field"><span>Audio format</span>
        <select value={tts.format} onChange={(e) => set('format', e.target.value as TtsSettings['format'])}><option>mp3</option><option>wav</option></select></label>
      <label className="check"><input type="checkbox" checked={tts.autoPlay} onChange={(e) => set('autoPlay', e.target.checked)} /> Auto-play replies (starts while streaming, sentence by sentence)</label>
      <label className="check"><input type="checkbox" checked={tts.skipActions} onChange={(e) => set('skipActions', e.target.checked)} /> Skip *actions* in asterisks</label>
      <label className="check"><input type="checkbox" checked={tts.speakThinking} onChange={(e) => set('speakThinking', e.target.checked)} /> Speak thinking (&lt;think&gt;/&lt;thinking&gt;/&lt;reasoning&gt;) — off = never read aloud</label>
      <button disabled={!tts.enabled || testing} onClick={onTest}>{testing ? 'Playing…' : '🔊 Test voice'}</button>
      <div className="muted">Audio is requested through the local proxy (/tts/*), so it works from your phone too. Setup: see TTS.md.</div>
    </section>
  );
}
