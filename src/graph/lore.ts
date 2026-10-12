// Lorebooks (keyword world info): per character (pgc.lore.<charId>) and global (pgc.lore._global).
import { storage } from './memory';
import { estimateTokens } from '../pipeline';
import { packLore, type PackSel } from './packs';

export interface LoreEntry {
  id: string; title: string; keys: string[]; content: string;
  enabled: boolean; constant: boolean; priority: number; caseSensitive: boolean; wholeWord: boolean;
}
export interface LoreFired { title: string; source: string; reason: string; tokens: number; included: boolean; }

const KEY = (ns?: string) => 'pgc.lore.' + (ns || '_global');
const lid = () => Math.random().toString(36).slice(2, 10);
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

export const blankEntry = (): LoreEntry => ({ id: lid(), title: 'New entry', keys: [], content: '', enabled: true, constant: false, priority: 100, caseSensitive: false, wholeWord: true });

/** Normalize anything entry-like (ours, SillyTavern world info, V2 character_book). */
export function normEntry(e: Record<string, unknown>, i = 0): LoreEntry {
  const ext = (e.extensions && typeof e.extensions === 'object' ? e.extensions : {}) as Record<string, unknown>;
  const num = (...v: unknown[]) => { for (const x of v) if (typeof x === 'number' && isFinite(x)) return x; return 100; };
  const bool = (d: boolean, ...v: unknown[]) => { for (const x of v) if (typeof x === 'boolean') return x; return d; };
  return {
    id: s(e.id) || (e.uid != null ? String(e.uid) : '') || lid(),
    title: s(e.title) || s(e.comment) || s(e.name) || strs(e.keys ?? e.key)[0] || 'Entry ' + (i + 1),
    keys: strs(e.keys ?? e.key), content: s(e.content),
    enabled: typeof e.disable === 'boolean' ? !e.disable : bool(true, e.enabled),
    constant: bool(false, e.constant),
    priority: num(e.priority === undefined || typeof e.order === 'number' || typeof e.insertion_order === 'number' ? undefined : e.priority, e.order, e.insertion_order, e.priority),
    caseSensitive: bool(false, e.caseSensitive, e.case_sensitive, ext.case_sensitive),
    wholeWord: bool(true, e.wholeWord, e.matchWholeWords, ext.match_whole_words),
  };
}
/** Parse a lorebook file: our export, SillyTavern world info ({entries:{...}}), character_book ({entries:[...]}), or a card containing one. */
export function parseLorebook(obj: unknown): LoreEntry[] {
  if (!obj || typeof obj !== 'object') throw new Error('Not a lorebook file');
  const o = obj as Record<string, unknown>;
  const d = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  const book = (d.character_book && typeof d.character_book === 'object' ? d.character_book : Array.isArray(o.lorebook) ? { entries: o.lorebook } : o) as Record<string, unknown>;
  const ents = book.entries;
  const list = Array.isArray(ents) ? ents : ents && typeof ents === 'object' ? Object.values(ents) : null;
  if (!list) throw new Error('No lorebook entries found');
  return list.filter((x) => x && typeof x === 'object').map((x, i) => normEntry(x as Record<string, unknown>, i));
}
/** SillyTavern world-info JSON (round-trips through parseLorebook). */
export function exportLorebook(entries: LoreEntry[], name = 'Lorebook') {
  return JSON.stringify({ name, entries: Object.fromEntries(entries.map((e, i) => [String(i), {
    uid: i, key: e.keys, keysecondary: [], comment: e.title, content: e.content, constant: e.constant, disable: !e.enabled,
    order: e.priority, caseSensitive: e.caseSensitive, matchWholeWords: e.wholeWord }])) }, null, 2);
}

export function loadLore(ns?: string): LoreEntry[] {
  try { const j = JSON.parse(storage().getItem(KEY(ns)) || 'null'); if (j && Array.isArray(j.entries)) return j.entries.map((e: Record<string, unknown>, i: number) => normEntry(e, i)); } catch { /* ignore */ }
  return [];
}
export function saveLore(entries: LoreEntry[], ns?: string) { storage().setItem(KEY(ns), JSON.stringify({ entries })); }

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does `key` match `text`? Keys written /like this/flags are regexes. Returns false on a bad regex. */
export function keyMatches(key: string, text: string, caseSensitive: boolean, wholeWord: boolean): boolean {
  const re = key.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (re) return new RegExp(re[1], re[2].replace('g', '') + (caseSensitive || re[2].includes('i') ? '' : 'i')).test(text);
    if (wholeWord) return new RegExp('(?<![\\p{L}\\p{N}_])' + esc(key) + '(?![\\p{L}\\p{N}_])', caseSensitive ? 'u' : 'iu').test(text);
  } catch { return false; }
  return caseSensitive ? text.includes(key) : text.toLowerCase().includes(key.toLowerCase());
}

export interface ScanOpts { scope: string; depth: number; budget: number; header: string; joiner: string;
  /** Knowledge packs to include (omitted = none). */ packs?: PackSel; level?: string; }
/** Scan text against character + global books. Matched entries are sorted by priority (high first) and added while they fit the token budget. */
export function scanLore(text: string, memNs: string | undefined, o: ScanOpts): { text: string; fired: LoreFired[] } {
  const wantChar = o.scope !== 'global', wantGlobal = o.scope !== 'character';
  const all = [...(wantChar && memNs ? loadLore(memNs).map((e) => ({ e, source: 'character' })) : []), ...(wantGlobal ? loadLore().map((e) => ({ e, source: 'global' })) : []),
    ...(o.packs ? packLore(memNs, o.packs, o.level) : [])];
  const hits: { e: LoreEntry; source: string; reason: string; i: number }[] = [];
  all.forEach(({ e, source }, i) => {
    if (!e.enabled || !e.content.trim()) return;
    if (e.constant) { hits.push({ e, source, reason: 'always on', i }); return; }
    const k = e.keys.find((key) => key.trim() && keyMatches(key.trim(), text, e.caseSensitive, e.wholeWord));
    if (k !== undefined) hits.push({ e, source, reason: `key "${k.trim()}"`, i });
  });
  hits.sort((a, b) => (Number(b.e.priority) || 0) - (Number(a.e.priority) || 0) || a.i - b.i);
  const chosen: string[] = [], fired: LoreFired[] = [];
  for (const h of hits) {
    const tokens = estimateTokens(h.e.content);
    const fits = !(o.budget > 0) || estimateTokens([...chosen, h.e.content].join(o.joiner)) <= o.budget;
    if (fits) chosen.push(h.e.content);
    fired.push({ title: h.e.title, source: h.source, reason: h.reason + (fits ? '' : ', over budget'), tokens, included: fits });
  }
  return { text: chosen.length ? (o.header ? o.header + '\n' : '') + chosen.join(o.joiner) : '', fired };
}
