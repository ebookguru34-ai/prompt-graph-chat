import type { Graph } from './graph/types';
import { CHAR_NS_PREFIX } from './graph/memory';
import { uid } from './storage';

export interface Character {
  id: string;            // starts with "char-"; also the memory namespace
  name: string;
  avatar?: string;       // small data URL
  system: string;        // character sheet / system prompt
  greeting: string;      // first assistant message of a new chat
  examples: string;      // example dialogue (optional)
  voice?: string;        // TTS voice override (blank = global voice)
  graph?: Graph | null;  // default graph for this character's chats (null/undefined = current editor graph)
  updatedAt: number;
}

export const newCharId = () => CHAR_NS_PREFIX + uid();
export const blankCharacter = (): Character => ({ id: newCharId(), name: 'New character', system: 'You are {{char}}. Stay in character while talking with {{user}}.', greeting: '', examples: '', graph: null, updatedAt: Date.now() });

/** Replace {{char}} / {{user}} (and SillyTavern's <BOT>/<USER>) in character text. */
export const substChar = (t: string, char: string, user: string) =>
  (t || '').replace(/\{\{\s*char\s*\}\}|<BOT>/gi, char).replace(/\{\{\s*user\s*\}\}|<USER>/gi, user);

/** System prompt used for chats with this character: sheet + example dialogue under a header. */
export function characterSystemPrompt(c: Character, userName: string) {
  const sys = substChar(c.system, c.name, userName).trim();
  const ex = substChar(c.examples, c.name, userName).trim();
  return ex ? (sys ? sys + '\n\n' : '') + '[Example dialogue]\n' + ex : sys;
}

// ---------- import / export ----------
export const EXPORT_SPEC = 'pgc_character_v1';
export function exportCharacter(c: Character) { return JSON.stringify({ spec: EXPORT_SPEC, ...c }, null, 2); }

type Card = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** Map our JSON, TavernAI V1, or V2/V3 (spec + data{}) card JSON into a Character (new id). */
export function characterFromJson(obj: unknown): Character {
  if (!obj || typeof obj !== 'object') throw new Error('Not a character file');
  const o = obj as Card;
  if (o.spec === EXPORT_SPEC) {
    if (!s(o.name)) throw new Error('Character has no name');
    return { ...blankCharacter(), name: s(o.name), avatar: s(o.avatar) || undefined, system: s(o.system), greeting: s(o.greeting), examples: s(o.examples), voice: s(o.voice) || undefined,
      graph: o.graph && typeof o.graph === 'object' ? o.graph as Graph : null };
  }
  const d = (o.data && typeof o.data === 'object' ? o.data : o) as Card; // V2/V3 keep fields under data
  const name = s(d.name) || s(o.name) || s(o.char_name);
  if (!name) throw new Error('Card has no name');
  const parts = [s(d.system_prompt), s(d.description) || s(o.char_persona),
    s(d.personality) && `Personality: ${s(d.personality)}`, s(d.scenario) || s(o.world_scenario) ? `Scenario: ${s(d.scenario) || s(o.world_scenario)}` : '']
    .map((x) => (x || '').trim()).filter(Boolean);
  return { ...blankCharacter(), name, system: parts.join('\n\n'), greeting: s(d.first_mes) || s(o.char_greeting), examples: s(d.mes_example) || s(o.example_dialogue) };
}

const b64ToUtf8 = (b64: string) => { const bin = atob(b64.trim()); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); };

/** Read tEXt/iTXt chunks from a PNG. Returns keyword -> text. */
export function pngTextChunks(buf: Uint8Array): Record<string, string> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) throw new Error('Not a PNG file');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out: Record<string, string> = {};
  const latin = new TextDecoder('latin1'), utf8 = new TextDecoder();
  for (let p = 8; p + 8 <= buf.length;) {
    const len = dv.getUint32(p), type = latin.decode(buf.subarray(p + 4, p + 8)), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') { const z = data.indexOf(0); if (z > 0) out[latin.decode(data.subarray(0, z))] = latin.decode(data.subarray(z + 1)); }
    else if (type === 'iTXt') { // keyword\0 compFlag compMethod lang\0 transKeyword\0 text (uncompressed only)
      const z = data.indexOf(0); if (z > 0 && data[z + 1] === 0) { let q = data.indexOf(0, z + 3); q = data.indexOf(0, q + 1); out[latin.decode(data.subarray(0, z))] = utf8.decode(data.subarray(q + 1)); }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** Parse a SillyTavern/TavernAI PNG card (prefers ccv3 over chara). Avatar is not set here. */
export function characterFromPng(buf: Uint8Array): Character {
  const t = pngTextChunks(buf);
  const raw = t.ccv3 ?? t.chara;
  if (!raw) throw new Error('PNG has no character data (no "chara" or "ccv3" chunk)');
  let json: unknown;
  try { json = JSON.parse(b64ToUtf8(raw)); } catch { json = JSON.parse(raw); }
  return characterFromJson(json);
}

/** Resize an image (File/Blob or data URL) to a small square-ish JPEG/PNG data URL. Browser only. */
export async function resizeImage(src: Blob, max = 160): Promise<string> {
  const url = URL.createObjectURL(src);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Could not read image')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}
