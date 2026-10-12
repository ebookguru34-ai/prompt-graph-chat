// Knowledge packs: installable, read-only lore sets (e.g. the Skyrim Oghma Infinium catalog), separate from the user's own
// lorebooks and document collections. A pack feeds the Lorebook node (keys = title + aliases + phrases) and the RAG Retrieve
// node (one chunk per article). Nothing from a pack is used unless it is installed, enabled (globally or by a character
// override), its categories are on, and the node's `packs` option allows it.
// Pack data lives in a registry (filled from IndexedDB by the app, or registerPack in tests/compiler parity);
// small settings live in the KV: pgc.packs.settings, pgc.packs.char.<charId>. Vectors: pgc.packemb.<packId> (or IndexedDB).
import { storage } from './memory';
import type { LoreEntry } from './lore';

export interface PackEntry { id: string; title: string; keys: string[]; aliases?: string[]; cats: string[]; basic: string; advanced?: string;
  checksum: string; tags?: string[]; basicClass?: string[]; advancedClass?: string[]; }
export interface PackCategory { id: string; label: string; group: string; count: number; }
export interface KnowledgePack {
  format: 'pgc-knowledge-pack'; formatVersion: number; id: string; name: string; version: string; description?: string;
  source?: Record<string, unknown>; license?: { spdx?: string; notice?: string; text?: string }; attribution?: string;
  categoryGroups?: { id: string; label: string }[]; categories: PackCategory[]; entries: PackEntry[];
}
export interface PackSettings { enabled: boolean; cats: Record<string, boolean>; }
export type CharOverride = 'inherit' | 'on' | 'off';
export interface PackSel { mode: string; ids: string[]; }

const REG = new Map<string, KnowledgePack>();
export const listPacks = () => [...REG.values()];
export const getPack = (id: string) => REG.get(id);
export function registerPack(p: KnowledgePack) { REG.set(p.id, p); }
export function unregisterPack(id: string) { REG.delete(id); }

/** Validate + normalize a parsed pack file. Throws with a readable message. */
export function validatePack(obj: unknown): KnowledgePack {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  if (o.format !== 'pgc-knowledge-pack') throw new Error('Not a knowledge pack (format must be "pgc-knowledge-pack")');
  if (typeof o.id !== 'string' || !/^[\w.-]{1,80}$/.test(o.id)) throw new Error('Pack id missing or invalid');
  if (!Array.isArray(o.entries)) throw new Error('Pack has no entries');
  const entries: PackEntry[] = (o.entries as Record<string, unknown>[]).filter((e) => e && typeof e === 'object' && typeof e.title === 'string').map((e, i) => ({
    ...(e as unknown as PackEntry), id: String(e.id ?? i), keys: Array.isArray(e.keys) ? e.keys.map(String).filter((k) => k.trim()) : [],
    cats: Array.isArray(e.cats) ? e.cats.map(String) : [], basic: String(e.basic ?? ''), advanced: String(e.advanced ?? ''), checksum: String(e.checksum ?? e.id ?? i) }));
  const counts: Record<string, number> = {}; for (const e of entries) for (const c of e.cats) counts[c] = (counts[c] || 0) + 1;
  const declared = Array.isArray(o.categories) ? (o.categories as PackCategory[]) : [];
  const cats = [...declared.map((c) => ({ id: String(c.id), label: String(c.label ?? c.id), group: String(c.group ?? 'type'), count: counts[c.id] || 0 })),
    ...Object.keys(counts).filter((c) => !declared.some((d) => d.id === c)).map((c) => ({ id: c, label: c, group: 'type', count: counts[c] }))];
  return { ...(o as unknown as KnowledgePack), name: String(o.name ?? o.id), version: String(o.version ?? ''), categories: cats, entries };
}

const SKEY = 'pgc.packs.settings', CKEY = (ns: string) => 'pgc.packs.char.' + ns;
const readJson = <T,>(k: string, d: T): T => { try { const v = JSON.parse(storage().getItem(k) || 'null'); return v && typeof v === 'object' ? v : d; } catch { return d; } };
export const allSettings = () => readJson<Record<string, PackSettings>>(SKEY, {});
/** Settings for a pack; a newly installed pack is enabled with every category on. */
export function packSettings(id: string): PackSettings { const s = allSettings()[id]; return { enabled: s ? s.enabled !== false : true, cats: s?.cats && typeof s.cats === 'object' ? s.cats : {} }; }
export function setPackSettings(id: string, p: Partial<PackSettings>) { const a = allSettings(); a[id] = { ...packSettings(id), ...p }; storage().setItem(SKEY, JSON.stringify(a)); }
export const charOverrides = (ns?: string) => (ns ? readJson<Record<string, CharOverride>>(CKEY(ns), {}) : {});
export function setCharOverride(ns: string, id: string, v: CharOverride) {
  const o = charOverrides(ns); if (v === 'inherit') delete o[id]; else o[id] = v; storage().setItem(CKEY(ns), JSON.stringify(o));
}
/** Pack on for this chat? Character override (on/off) wins over the global toggle. */
export function packEnabledFor(id: string, ns?: string) { const o = charOverrides(ns)[id]; return o === 'on' ? true : o === 'off' ? false : packSettings(id).enabled; }
export const catOn = (s: PackSettings, c: string) => s.cats[c] !== false;
export const entryOn = (s: PackSettings, e: PackEntry) => e.cats.every((c) => catOn(s, c));

/** Node option -> selection. 'none' or unknown -> nothing; 'selected' uses the comma list of pack ids. */
export function parseSel(mode: unknown, ids: unknown): PackSel {
  return { mode: String(mode ?? 'all enabled'), ids: String(ids ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
}
/** Entries a node may use: pack allowed by the node, enabled for this chat, and every category of the entry on. */
export function activeEntries(ns: string | undefined, sel: PackSel): { pack: KnowledgePack; entry: PackEntry; index: number }[] {
  if (sel.mode !== 'all enabled' && sel.mode !== 'selected') return [];
  const out: { pack: KnowledgePack; entry: PackEntry; index: number }[] = [];
  for (const pack of [...REG.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (sel.mode === 'selected' && !sel.ids.includes(pack.id)) continue;
    if (!packEnabledFor(pack.id, ns)) continue;
    const s = packSettings(pack.id);
    pack.entries.forEach((entry, index) => { if (entryOn(s, entry)) out.push({ pack, entry, index }); });
  }
  return out;
}
/** Text for a knowledge level: 'advanced' uses the specialist text when the entry has one. */
export const packText = (e: PackEntry, level: unknown) => (level === 'advanced' && e.advanced ? e.advanced : e.basic);
export const PACK_PRIORITY = 50;
/** Pack entries as lorebook entries (below the default user priority of 100, so the user's own lore wins the budget). */
export function packLore(ns: string | undefined, sel: PackSel, level: unknown): { e: LoreEntry; source: string }[] {
  return activeEntries(ns, sel).map(({ pack, entry }) => ({ source: 'pack:' + pack.id, e: { id: pack.id + ':' + entry.id, title: entry.title, keys: entry.keys,
    content: packText(entry, level), enabled: true, constant: false, priority: PACK_PRIORITY, caseSensitive: false, wholeWord: true } }));
}
/** Embedding text (fixed, independent of the knowledge level, so one vector per entry checksum). */
export const packEmbedText = (e: PackEntry) => e.title + '\n' + (e.aliases?.length ? 'Also known as: ' + e.aliases.join(', ') + '\n' : '') + e.basic;
/** Text BM25 scores for an article (title + keys + the injected text). */
export const packSearchText = (e: PackEntry, level: unknown) => e.title + '\n' + e.keys.join(', ') + '\n' + packText(e, level);

// ---- vectors: per pack, keyed by entry checksum ----
export interface PackVecStore { load(id: string): Promise<Record<string, number[]>>; put(id: string, vecs: Record<string, number[]>): Promise<void>; clear(id: string): Promise<void>; }
const VKEY = (id: string) => 'pgc.packemb.' + id;
const kvStore: PackVecStore = {
  load: async (id) => readJson<Record<string, number[]>>(VKEY(id), {}),
  put: async (id, v) => { storage().setItem(VKEY(id), JSON.stringify({ ...readJson<Record<string, number[]>>(VKEY(id), {}), ...v })); },
  clear: async (id) => { storage().removeItem?.(VKEY(id)); },
};
let vstore: PackVecStore = kvStore;
const VCACHE = new Map<string, Record<string, number[]>>();
/** The app swaps in IndexedDB (localStorage is too small for thousands of vectors). */
export function setPackVecStore(s: PackVecStore | null) { vstore = s ?? kvStore; VCACHE.clear(); }
export async function packVectors(id: string) { let v = VCACHE.get(id); if (!v) { v = await vstore.load(id); VCACHE.set(id, v); } return v; }
export const round5 = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);
export async function embedMissing(packId: string, entries: PackEntry[], embed: (t: string[]) => Promise<number[][]>, batch = 32,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const have = await packVectors(packId); const miss = entries.filter((e) => !have[e.checksum]);
  for (let i = 0; i < miss.length; i += batch) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const part = miss.slice(i, i + batch); const vecs = await embed(part.map(packEmbedText));
    const add: Record<string, number[]> = {}; part.forEach((e, j) => { add[e.checksum] = round5(vecs[j]); });
    Object.assign(have, add); await vstore.put(packId, add);
    onProgress?.(Math.min(i + batch, miss.length), miss.length);
  }
  return miss.length;
}
/** Embed every article of a pack (UI button). Resumable: only missing checksums are computed. */
export async function embedPack(id: string, embed: (t: string[]) => Promise<number[][]>, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, fresh = false) {
  const p = REG.get(id); if (!p) throw new Error('No pack ' + id);
  if (fresh) await clearPackVectors(id);
  return embedMissing(id, p.entries, embed, 32, onProgress, signal);
}
export async function clearPackVectors(id: string) { VCACHE.delete(id); await vstore.clear(id); }
export async function embeddedPackCount(id: string) { const p = REG.get(id); if (!p) return 0; const v = await packVectors(id); return p.entries.filter((e) => v[e.checksum]).length; }
/** Retrieval embeds at most this many missing pack articles on the fly; beyond that they score by keyword only. */
export const LAZY_EMBED_MAX = 64;
