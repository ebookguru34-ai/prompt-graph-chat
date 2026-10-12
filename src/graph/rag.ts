// Document collections for RAG: per character (pgc.rag.<charId>) and global (pgc.rag._global).
// Docs are chunked on import; vectors live in the shared embedding cache (pgc.emb.<hash of chunk>).
import { storage } from './memory';
import { bm25Rank, cachedEmbeddings, cosine, hash } from './search';
import { estimateTokens } from '../pipeline';

export interface RagDoc { id: string; name: string; addedAt: number; size: number; overlap: number; chunks: string[]; }
const KEY = (ns?: string) => 'pgc.rag.' + (ns || '_global');
const did = () => Math.random().toString(36).slice(2, 10);

export function loadDocs(ns?: string): RagDoc[] {
  try { const j = JSON.parse(storage().getItem(KEY(ns)) || 'null'); if (j && Array.isArray(j.docs)) return j.docs; } catch { /* ignore */ }
  return [];
}
export function saveDocs(docs: RagDoc[], ns?: string) { storage().setItem(KEY(ns), JSON.stringify({ docs })); }

function splitLong(b: string, size: number): string[] {
  if (b.length <= size) return [b];
  const out: string[] = []; let cur = '';
  for (const sent of b.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [b]) {
    if (sent.length > size) { if (cur.trim()) out.push(cur.trim()); cur = ''; for (let i = 0; i < sent.length; i += size) out.push(sent.slice(i, i + size).trim()); continue; }
    if (cur.length + sent.length > size && cur.trim()) { out.push(cur.trim()); cur = ''; }
    cur += sent;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
const tail = (s: string, n: number) => { if (n <= 0) return ''; const t = s.slice(-n); const i = t.indexOf(' '); return (i >= 0 && s.length > n ? t.slice(i + 1) : t).trim(); };

/** Split text into ~size-char chunks: breaks at markdown headings, packs paragraphs, splits long ones by sentence;
 *  each chunk after the first in a section starts with `overlap` chars of the previous one (and the section heading). */
export function chunkText(text: string, size = 800, overlap = 100): string[] {
  size = Math.max(100, Math.floor(Number(size)) || 800); overlap = Math.max(0, Math.min(Math.floor(size / 2), Math.floor(Number(overlap)) || 0));
  const chunks: string[] = []; let cur = '', heading = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const b = block.trim(); if (!b) continue;
    if (/^#{1,6}\s/.test(b)) { flush(); heading = b.split('\n')[0].replace(/^#+\s*/, '').trim(); }
    for (const p of /^#{1,6}\s/.test(b) ? [b] : splitLong(b, size)) {
      if (cur && cur.length + 2 + p.length > size) {
        const t = tail(cur, overlap); flush();
        cur = (heading && !p.startsWith('#') ? '# ' + heading + '\n' : '') + (t ? t + '\n\n' : '') + p;
      } else cur = cur ? cur + '\n\n' + p : p;
    }
  }
  flush();
  return chunks;
}
export function addDoc(ns: string | undefined, name: string, text: string, size = 800, overlap = 100): RagDoc {
  const d: RagDoc = { id: did(), name, addedAt: Date.now(), size, overlap, chunks: chunkText(text, size, overlap) };
  saveDocs([...loadDocs(ns), d], ns); return d;
}
export function embeddedCount(d: RagDoc) { const kv = storage(); return d.chunks.filter((c) => kv.getItem('pgc.emb.' + hash(c))).length; }
export function dropVectors(d: RagDoc) { const kv = storage(); for (const c of d.chunks) kv.removeItem?.('pgc.emb.' + hash(c)); }

export interface RagHit { doc: string; source: string; chunk: number; text: string; score: number; included: boolean; }
export interface RetrieveOpts { scope: string; topK: number; minScore: number; budget: number; header: string; joiner: string; method: string; }
/** Rank chunks of the character + global collections for `query`. embeddings/hybrid fall back to keyword (BM25) on error. */
export async function retrieve(query: string, memNs: string | undefined, o: RetrieveOpts, embed: ((t: string[]) => Promise<number[][]>) | null) {
  const all: { doc: string; source: string; chunk: number; text: string }[] = [];
  const add = (ns: string | undefined, source: string) => { for (const d of loadDocs(ns)) d.chunks.forEach((text, chunk) => all.push({ doc: d.name, source, chunk, text })); };
  if (o.scope !== 'global' && memNs) add(memNs, 'character');
  if (o.scope !== 'character') add(undefined, 'global');
  if (!query.trim() || !all.length) return { text: '', hits: [] as RagHit[], method: 'none', note: '' };
  const docs = all.map((x) => x.text);
  let method = o.method, note = '', scored: { i: number; score: number }[];
  const kw = () => bm25Rank(query, docs);
  if (method !== 'keyword' && embed) {
    try {
      const [qv, ...dv] = await cachedEmbeddings([query, ...docs], embed);
      const cos = dv.map((v) => cosine(qv, v));
      if (method === 'hybrid') {
        const b = new Map(kw().map((r) => [r.i, r.score])); const mx = Math.max(0, ...b.values()) || 1;
        scored = cos.map((c, i) => ({ i, score: 0.7 * c + 0.3 * ((b.get(i) ?? 0) / mx) }));
      } else scored = cos.map((score, i) => ({ i, score }));
      scored.sort((x, y) => y.score - x.score || x.i - y.i);
    } catch (e) { note = method + ' failed (' + (e as Error).message + '), used keyword'; method = 'keyword'; scored = kw(); }
  } else { if (method !== 'keyword') note = 'no embeddings (dry run), used keyword'; method = 'keyword'; scored = kw(); }
  const top = scored.filter((r) => r.score >= o.minScore).slice(0, Math.max(1, o.topK));
  const chosen: string[] = []; const hits: RagHit[] = [];
  for (const r of top) {
    const fits = !(o.budget > 0) || estimateTokens([...chosen, docs[r.i]].join(o.joiner)) <= o.budget;
    if (fits) chosen.push(docs[r.i]);
    hits.push({ ...all[r.i], score: r.score, included: fits });
  }
  return { text: chosen.length ? (o.header ? o.header + '\n' : '') + chosen.join(o.joiner) : '', hits, method, note };
}
