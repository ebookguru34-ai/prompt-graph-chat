// Memory search: BM25-style keyword ranking (no deps) and embedding similarity with a localStorage vector cache.
import { storage } from './memory';

const STOP = new Set('a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when where which who will with you your'.split(' '));
export const tokenize = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** BM25 (k1=1.2, b=0.75). Returns indices of docs sorted by score (only score > 0), best first. */
export function bm25Rank(query: string, docs: string[], k1 = 1.2, b = 0.75): { i: number; score: number }[] {
  const q = Array.from(new Set(tokenize(query))); if (!q.length || !docs.length) return [];
  const toks = docs.map(tokenize), avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map(q.map((w) => [w, toks.filter((t) => t.includes(w)).length]));
  return toks.map((t, i) => {
    let score = 0;
    for (const w of q) {
      const f = t.filter((x) => x === w).length; if (!f) continue;
      const n = df.get(w)!, idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * t.length / avg));
    }
    return { i, score };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score || y.i - x.i);
}

export function hash(s: string) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length.toString(36); }
export function cosine(a: number[], b: number[]) { let d = 0, x = 0, y = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; }

const EMB = 'pgc.emb.';
/** Embed texts, using/filling the cache (pgc.emb.<hash>). `embed` does the network call for misses. */
export async function cachedEmbeddings(texts: string[], embed: (t: string[]) => Promise<number[][]>): Promise<number[][]> {
  const kv = storage(); const keys = texts.map((t) => EMB + hash(t));
  const out: (number[] | null)[] = keys.map((k) => { try { const v = kv.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } });
  const miss = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (miss.length) {
    const vecs = await embed(miss.map((i) => texts[i]));
    miss.forEach((i, j) => { out[i] = vecs[j]; try { kv.setItem(keys[i], JSON.stringify(vecs[j].map((x) => Math.round(x * 1e5) / 1e5))); } catch { /* quota: skip cache */ } });
  }
  return out as number[][];
}
export async function embeddingRank(query: string, docs: string[], embed: (t: string[]) => Promise<number[][]>) {
  const [qv, ...dv] = await cachedEmbeddings([query, ...docs], embed);
  return dv.map((v, i) => ({ i, score: cosine(qv, v) })).sort((x, y) => y.score - x.score);
}

/** Which turn this generation is: assistant replies already in history + 1 (regenerate doesn't advance it). */
export const turnNumber = (history: { role: string }[]) => history.filter((m) => m.role === 'assistant').length + 1;
export type EveryMode = 'every N turns' | 'after turn X' | 'once at turn X' | 'between X-Y';
export function everyFires(mode: string, turn: number, n: number, x: number, y: number, offset: number) {
  switch (mode) {
    case 'after turn X': return turn > x;
    case 'once at turn X': return turn === x;
    case 'between X-Y': return turn >= Math.min(x, y) && turn <= Math.max(x, y);
    default: { const N = Math.max(1, Math.floor(n) || 1); return ((turn - offset) % N + N) % N === 0 && turn - offset > 0; }
  }
}
