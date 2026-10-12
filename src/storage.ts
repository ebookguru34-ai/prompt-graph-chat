export function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem('pgc.' + key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
export function save(key: string, value: unknown) { localStorage.setItem('pgc.' + key, JSON.stringify(value)); }
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
