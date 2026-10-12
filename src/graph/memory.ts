/** Memory stores: localStorage key `pgc.mem.<store>` holding a JSON array of entries.
 *  Entry = { text, turn?, prev? }. Legacy plain strings are read as untagged entries.
 *  `turn` = id of the assistant reply being generated when the entry was written.
 *  `prev` (replace mode only) = the store's entries before the replace, restored on rollback. */
export interface MemEntry { text: string; turn?: string; prev?: MemEntry[]; }
type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; keys(): string[] };
const ls = (): KV => ({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v), keys: () => Object.keys(localStorage) });
let kv: () => KV = ls;
/** Shared key-value backend (localStorage, or a test double via setMemStorage). */
export const storage = (): KV => kv();
/** For tests: swap the backing storage. */
export function setMemStorage(s: KV | null) { kv = s ? () => s : ls; }

const PREFIX = 'pgc.mem.';
/** Character ids start with this, so their namespaced keys never clash with legacy store names. */
export const CHAR_NS_PREFIX = 'char-';
/** Key for a store. `ns` = character id (pgc.mem.<charId>.<store>); no ns = legacy key pgc.mem.<store>. */
export const memKey = (s: unknown, ns?: string) => PREFIX + (ns ? ns + '.' : '') + (String(s || 'default'));
const norm = (e: unknown): MemEntry | null => typeof e === 'string' ? { text: e }
  : e && typeof e === 'object' && typeof (e as MemEntry).text === 'string' ? e as MemEntry : null;

function readKey(key: string): MemEntry[] {
  try { const a = JSON.parse(kv().getItem(key) || '[]'); return Array.isArray(a) ? a.map(norm).filter((x): x is MemEntry => !!x) : []; } catch { return []; }
}
export function readEntries(store: string, ns?: string): MemEntry[] { return readKey(memKey(store, ns)); }
export function writeEntries(store: string, items: MemEntry[], ns?: string) { kv().setItem(memKey(store, ns), JSON.stringify(items)); }
/** Text of each entry (for Memory Read node and the editor inspector). */
export function readMem(store: string, ns?: string): string[] { return readEntries(store, ns).map((e) => e.text); }
/** Overwrite a store with untagged entries (e.g. "Clear store"). */
export function writeMem(store: string, items: string[], ns?: string) { writeEntries(store, items.map((text) => ({ text })), ns); }
/** Store names visible to a character (ns) or to no-character chats (legacy keys, excluding character namespaces). */
export function listStores(ns?: string): string[] {
  const keys = kv().keys().filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
  return ns ? keys.filter((k) => k.startsWith(ns + '.')).map((k) => k.slice(ns.length + 1)) : keys.filter((k) => !k.startsWith(CHAR_NS_PREFIX));
}

/** Add an entry tagged with `turn`. Replace mode keeps the previous entries in `prev` for rollback. */
export function appendMem(store: string, text: string, turn: string | undefined, mode: 'append' | 'replace', maxEntries = 0, ns?: string) {
  const old = readEntries(store, ns);
  let items: MemEntry[] = mode === 'replace' ? [{ text, turn, prev: turn ? old : undefined }] : [...old, { text, turn }];
  if (maxEntries > 0) items = items.slice(-maxEntries);
  writeEntries(store, items, ns);
}

function rollbackList(items: MemEntry[], turns: Set<string>): MemEntry[] {
  const out: MemEntry[] = [];
  for (const e of items) {
    if (e.turn && turns.has(e.turn)) { if (e.prev) { out.length = 0; out.push(...rollbackList(e.prev, turns)); } continue; }
    out.push(e.prev ? { ...e, prev: rollbackList(e.prev, turns) } : e);
  }
  return out;
}
/** Remove every entry written by the given turns in all stores; undo their replaces. Returns number of stores changed. */
export function rollbackTurns(turnIds: string[]): number {
  const turns = new Set(turnIds.filter(Boolean)); if (!turns.size) return 0;
  let changed = 0;
  for (const k of kv().keys().filter((x) => x.startsWith(PREFIX))) { // every store, every character namespace
    const before = readKey(k), after = rollbackList(before, turns);
    if (JSON.stringify(before) !== JSON.stringify(after)) { kv().setItem(k, JSON.stringify(after)); changed++; }
  }
  return changed;
}
