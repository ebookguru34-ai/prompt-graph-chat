// Dynamic character profiles: schema + values + commit history, stored per character at pgc.profile.<charId>
// (no-character chats use pgc.profile._global). Every change is a commit tagged with the chat turn, so
// regenerate/edit/delete can roll it back like memory.
import { storage, rollbackTurns as rollbackMemTurns } from './memory';

export type FieldType = 'text' | 'number' | 'list' | 'map';
export interface ProfileField { key: string; type: FieldType; description?: string; min?: number; max?: number; locked?: boolean; default?: unknown; }
export type Source = 'llm' | 'user' | 'rule';
export interface Commit {
  id: string; turn?: string; ts: number; source: Source; note?: string;
  patch: Record<string, unknown>;   // what was requested (after validation)
  before: Record<string, unknown>;  // value of each changed path before (null = was absent)
  after: Record<string, unknown>;
  rolledBack?: { ts: number; reason: string };
}
export interface Profile { schema: ProfileField[]; values: Record<string, unknown>; commits: Commit[]; }

const KEY = (ns?: string) => 'pgc.profile.' + (ns || '_global');
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const cid = () => Math.random().toString(36).slice(2, 10);

export function loadProfile(ns?: string): Profile {
  try { const p = JSON.parse(storage().getItem(KEY(ns)) || 'null'); if (p && Array.isArray(p.schema)) return { schema: p.schema, values: p.values || {}, commits: p.commits || [] }; } catch { /* ignore */ }
  return { schema: [], values: {}, commits: [] };
}
export function saveProfile(p: Profile, ns?: string) { storage().setItem(KEY(ns), JSON.stringify(p)); }
export function listProfileNamespaces(): string[] { return storage().keys().filter((k) => k.startsWith('pgc.profile.')).map((k) => k.slice(12)); }

// ---- dot paths ----
export function getPath(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
}
export function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split('.'); let cur = o;
  for (const k of ks.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
  if (v === undefined) delete cur[ks[ks.length - 1]]; else cur[ks[ks.length - 1]] = v;
}
/** Current value of a field, falling back to its default. */
export function fieldValue(p: Profile, f: ProfileField): unknown { const v = getPath(p.values, f.key); return v === undefined ? clone(f.default) : v; }

// ---- validation ----
export interface Validated { patch: Record<string, unknown>; rejected: { key: string; reason: string }[]; }
const clamp = (n: number, f: ProfileField) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Flatten a nested patch into schema paths ({trust:{player:5}} -> {"trust.player":5}). Map fields stay whole. */
export function flattenPatch(raw: Record<string, unknown>, schema: ProfileField[], prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const path = prefix ? prefix + '.' + k : k;
    const isField = schema.some((f) => f.key === path);
    const isParent = schema.some((f) => f.key.startsWith(path + '.'));
    if (!isField && isParent && v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenPatch(v as Record<string, unknown>, schema, path));
    else out[path] = v;
  }
  return out;
}

/** Turn a requested change into the new value for a field, or throw a reason. `who` = llm respects locks. */
export function coerce(f: ProfileField, req: unknown, current: unknown): unknown {
  switch (f.type) {
    case 'number': {
      const cur = typeof current === 'number' ? current : Number(f.default ?? 0) || 0;
      if (typeof req === 'number' && isFinite(req)) return round(clamp(req, f));
      if (typeof req === 'string') {
        const m = req.trim().match(/^([+-])\s*(\d+(?:\.\d+)?)$/);
        if (m) return round(clamp(cur + (m[1] === '-' ? -1 : 1) * Number(m[2]), f)); // delta "+5" / "-3"
        const n = Number(req.trim()); if (req.trim() && isFinite(n)) return round(clamp(n, f));
      }
      throw new Error('not a number or +N/-N delta');
    }
    case 'text':
      if (typeof req === 'string') return req;
      if (typeof req === 'number' || typeof req === 'boolean') return String(req);
      throw new Error('not text');
    case 'list': {
      const cur = Array.isArray(current) ? current.map(String) : [];
      if (Array.isArray(req)) return req.map(String);
      if (typeof req === 'string') { // "+item" adds, "-item" removes
        const s = req.trim();
        if (s.startsWith('+')) return cur.includes(s.slice(1).trim()) ? cur : [...cur, s.slice(1).trim()];
        if (s.startsWith('-')) return cur.filter((x) => x !== s.slice(1).trim());
        return [...cur, s];
      }
      if (req && typeof req === 'object') { const o = req as { add?: unknown[]; remove?: unknown[] };
        if (o.add || o.remove) { const rm = (o.remove || []).map(String); return [...cur.filter((x) => !rm.includes(x)), ...(o.add || []).map(String).filter((x) => !cur.includes(x))]; } }
      throw new Error('not a list');
    }
    case 'map': {
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('not an object');
      const next = { ...((current && typeof current === 'object' ? current : {}) as Record<string, unknown>) };
      for (const [k, v] of Object.entries(req as Record<string, unknown>)) { if (v === null) delete next[k]; else next[k] = v; } // merge; null deletes
      return next;
    }
  }
}

/** Validate a raw patch against the schema. LLM patches can't touch locked fields; unknown keys are rejected. */
export function validatePatch(p: Profile, raw: Record<string, unknown>, source: Source): Validated {
  const flat = flattenPatch(raw, p.schema), patch: Record<string, unknown> = {}, rejected: Validated['rejected'] = [];
  for (const [key, req] of Object.entries(flat)) {
    const f = p.schema.find((x) => x.key === key);
    if (!f) { rejected.push({ key, reason: 'unknown key' }); continue; }
    if (f.locked && source !== 'user') { rejected.push({ key, reason: 'locked' }); continue; }
    try { patch[key] = coerce(f, req, fieldValue(p, f)); } catch (e) { rejected.push({ key, reason: (e as Error).message }); }
  }
  return { patch, rejected };
}

/** Apply a validated patch as a commit. Returns the commit (null if nothing changed). Mutates and saves. */
export function commit(p: Profile, patch: Record<string, unknown>, source: Source, turn?: string, ns?: string, note?: string): Commit | null {
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const old = getPath(p.values, k);
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    before[k] = old === undefined ? null : clone(old); after[k] = clone(v); setPath(p.values, k, clone(v)); // before null = was absent (JSON drops undefined)
  }
  if (!Object.keys(after).length) return null;
  const c: Commit = { id: cid(), turn, ts: Date.now(), source, note, patch: clone(patch), before, after };
  p.commits.push(c); saveProfile(p, ns);
  return c;
}

const undo = (p: Profile, c: Commit, reason: string) => { for (const [k, v] of Object.entries(c.before)) setPath(p.values, k, v === null ? undefined : clone(v)); c.rolledBack = { ts: Date.now(), reason }; };

/** Roll back every live commit tagged with these turns (newest first), in all profiles. History is kept (marked rolledBack). */
export function rollbackProfileTurns(turnIds: string[]): number {
  const turns = new Set(turnIds.filter(Boolean)); if (!turns.size) return 0;
  let n = 0;
  for (const ns of listProfileNamespaces()) {
    const p = loadProfile(ns === '_global' ? undefined : ns); let changed = false;
    for (const c of [...p.commits].reverse()) if (c.turn && turns.has(c.turn) && !c.rolledBack) { undo(p, c, 'turn removed'); changed = true; n++; }
    if (changed) saveProfile(p, ns === '_global' ? undefined : ns);
  }
  return n;
}
/** Memory + profile rollback for removed turns (use this from the chat UI). */
export function rollbackTurns(turnIds: string[]) { rollbackMemTurns(turnIds); rollbackProfileTurns(turnIds); }

/** User "revert to here": undo every live commit after `commitId`. */
export function revertTo(ns: string | undefined, commitId: string): number {
  const p = loadProfile(ns); const i = p.commits.findIndex((c) => c.id === commitId); if (i < 0) return 0;
  let n = 0;
  for (const c of p.commits.slice(i + 1).reverse()) if (!c.rolledBack) { undo(p, c, 'reverted by user'); n++; }
  saveProfile(p, ns); return n;
}

// ---- LLM patch parsing ----
/** Extract the first JSON object from model output (strips <think>, code fences; tolerates trailing commas). */
export function parsePatchText(text: string): Record<string, unknown> {
  let t = text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, '');
  const close = t.search(/<\/(think|thinking|reasoning)>/i); if (close !== -1) t = t.slice(t.indexOf('>', close) + 1);
  t = t.replace(/```(?:json)?/gi, '');
  for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const s = t.slice(start, i + 1);
        for (const cand of [s, s.replace(/,\s*([}\]])/g, '$1')]) { try { const o = JSON.parse(cand); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ } }
        break;
      }
    }
  }
  throw new Error('no JSON object found in model output');
}

// ---- prompt + rendering ----
export function describeField(f: ProfileField) {
  const range = f.type === 'number' && (f.min != null || f.max != null) ? ` ${f.min ?? '-∞'}..${f.max ?? '∞'}` : '';
  return `- ${f.key} (${f.type}${range})${f.description ? ': ' + f.description : ''}`;
}
export function profileLines(p: Profile) { return p.schema.map((f) => `${f.key}: ${fmt(fieldValue(p, f))}`).join('\n'); }
export const fmt = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
export function updateInstruction(p: Profile, context: string, text: string, extra = '') {
  const editable = p.schema.filter((f) => !f.locked);
  return [
    'You maintain a character state profile. Based on the latest exchange, decide which fields should change.',
    'Editable fields:', ...editable.map(describeField),
    '', 'Current profile:', profileLines(p) || '(empty)',
    '', 'Latest exchange:', context ? 'User: ' + context : '', text ? 'Character: ' + text : '',
    '', 'Rules: reply with ONE JSON object only, no prose. Use dot-path keys from the list. For numbers you may give an absolute value or a delta string like "+5" or "-3". For lists give the full array, or "+item"/"-item". For maps give an object of keys to merge (null deletes). Return {} if nothing should change.',
    extra,
  ].filter((x) => x !== '').join('\n');
}

// ---- tick rules (Stats node) ----
/** Rules, one per line: "<path> -> <target> by <n>" (drift toward target) or "<path> decay <n>" (minus n per turn, clamped). */
export function parseRules(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    let m = l.match(/^([\w.]+)\s*->\s*(-?\d+(?:\.\d+)?)\s+by\s+(\d+(?:\.\d+)?)$/i);
    if (m) return { path: m[1], target: Number(m[2]), step: Number(m[3]) };
    m = l.match(/^([\w.]+)\s+decay\s+(\d+(?:\.\d+)?)$/i);
    if (m) return { path: m[1], target: -Infinity, step: Number(m[2]) };
    return { error: l };
  });
}
/** Apply tick rules once per turn (tag = node id). Skips if a live rule commit for this turn+node exists. */
export function applyTick(ns: string | undefined, rulesText: string, turn: string, nodeId: string): { commit: Commit | null; errors: string[] } {
  const p = loadProfile(ns); const errors: string[] = []; const patch: Record<string, unknown> = {};
  if (p.commits.some((c) => c.source === 'rule' && c.turn === turn && c.note === nodeId && !c.rolledBack)) return { commit: null, errors };
  for (const r of parseRules(rulesText)) {
    if ('error' in r) { errors.push('bad rule: ' + r.error); continue; }
    const f = p.schema.find((x) => x.key === r.path);
    if (!f || f.type !== 'number') { errors.push(r.path + ': not a number field'); continue; }
    const cur = Number(fieldValue(p, f)) || 0;
    const next = cur > r.target ? Math.max(r.target, cur - r.step) : Math.min(r.target, cur + r.step);
    patch[r.path] = round(clamp(next, f));
  }
  return { commit: commit(p, patch, 'rule', turn, ns, nodeId), errors };
}

/** Starter schema offered in the profile editor. */
export const EXAMPLE_SCHEMA: ProfileField[] = [
  { key: 'mood', type: 'text', description: 'current emotional state, one or two words', default: 'neutral' },
  { key: 'trust.player', type: 'number', description: 'how much the character trusts the user', min: 0, max: 100, default: 50 },
  { key: 'energy', type: 'number', description: 'physical energy', min: 0, max: 100, default: 80 },
  { key: 'inventory', type: 'list', description: 'items the character carries', default: [] },
  { key: 'relationships', type: 'map', description: 'name -> short description of relationship', default: {} },
  { key: 'name', type: 'text', description: 'character name', locked: true },
];
