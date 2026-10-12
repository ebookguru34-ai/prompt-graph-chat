// Browser persistence for knowledge packs: IndexedDB database "pgc-packs" with stores "packs" (id -> pack JSON) and
// "vectors" ("<packId>|<checksum>" -> Float32Array). localStorage only keeps the small settings (see packs.ts).
import { clearPackVectors, listPacks, registerPack, setPackVecStore, unregisterPack, validatePack, type KnowledgePack } from './packs';
import { storage } from './memory';

const open = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('pgc-packs', 1);
  r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs'); if (!db.objectStoreNames.contains('vectors')) db.createObjectStore('vectors'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode); const req = fn(t.objectStore(store)); let out: T;
    if (req) req.onsuccess = () => { out = req.result as T; };
    t.oncomplete = () => { db.close(); res(out); }; t.onerror = () => { db.close(); rej(t.error); }; t.onabort = () => { db.close(); rej(t.error); };
  });
}
const range = (id: string) => IDBKeyRange.bound(id + '|', id + '|\uffff');

const idbVectors = {
  async load(id: string) {
    const db = await open();
    return new Promise<Record<string, number[]>>((res, rej) => {
      const out: Record<string, number[]> = {}; const c = db.transaction('vectors').objectStore('vectors').openCursor(range(id));
      c.onsuccess = () => { const cur = c.result; if (cur) { out[String(cur.key).slice(id.length + 1)] = Array.from(cur.value as Float32Array); cur.continue(); } else { db.close(); res(out); } };
      c.onerror = () => { db.close(); rej(c.error); };
    });
  },
  put: (id: string, v: Record<string, number[]>) => tx<void>('vectors', 'readwrite', (s) => { for (const [k, x] of Object.entries(v)) s.put(new Float32Array(x), id + '|' + k); }),
  clear: (id: string) => tx<void>('vectors', 'readwrite', (s) => s.delete(range(id))),
};

/** Load installed packs into the registry and use IndexedDB for pack vectors. Call once at startup. */
export async function initPacks() {
  if (typeof indexedDB === 'undefined') return;
  setPackVecStore(idbVectors);
  try { const all = await tx<KnowledgePack[]>('packs', 'readonly', (s) => s.getAll()); for (const p of all ?? []) registerPack(p); }
  catch (e) { console.warn('knowledge packs: could not open IndexedDB', e); }
}

/** Read a stored zip (methods 0 = stored, 8 = deflate) and return its files. */
export async function unzip(buf: ArrayBuffer): Promise<{ name: string; data: Uint8Array }[]> {
  const v = new DataView(buf); let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const n = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true); const out: { name: string; data: Uint8Array }[] = [];
  for (let k = 0; k < n; k++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), loc = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen)); p += 46 + nlen + xlen + clen;
    const start = loc + 30 + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true); const raw = new Uint8Array(buf, start, csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) });
  }
  return out;
}

/** Install a pack from a .json or .zip file (zip: the first .json that is a pack). Replaces a pack with the same id. */
export async function installPackFile(f: File): Promise<KnowledgePack> {
  let obj: unknown;
  if (/\.zip$/i.test(f.name)) {
    const files = (await unzip(await f.arrayBuffer())).filter((x) => /\.json$/i.test(x.name));
    for (const x of files) { try { const o = JSON.parse(new TextDecoder().decode(x.data)); if (o?.format === 'pgc-knowledge-pack') { obj = o; break; } } catch { /* next */ } }
    if (!obj) throw new Error('No pack .json inside the zip');
  } else obj = JSON.parse(await f.text());
  const p = validatePack(obj);
  if (listPacks().some((x) => x.id === p.id)) await clearPackVectors(p.id); // texts may have changed; checksums keep valid vectors anyway
  await tx<void>('packs', 'readwrite', (s) => s.put(p, p.id));
  registerPack(p); return p;
}
/** Uninstall: removes pack data, its vectors, its settings and every character override for it. */
export async function uninstallPack(id: string) {
  await tx<void>('packs', 'readwrite', (s) => s.delete(id)); await clearPackVectors(id); unregisterPack(id);
  const kv = storage(); try { const a = JSON.parse(kv.getItem('pgc.packs.settings') || '{}'); delete a[id]; kv.setItem('pgc.packs.settings', JSON.stringify(a)); } catch { /* ignore */ }
  for (const k of kv.keys().filter((x) => x.startsWith('pgc.packs.char.'))) { try { const o = JSON.parse(kv.getItem(k) || '{}'); if (id in o) { delete o[id]; kv.setItem(k, JSON.stringify(o)); } } catch { /* ignore */ } }
}
