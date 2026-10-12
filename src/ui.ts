import { useEffect, useState } from 'react';

const MQ = '(max-width: 768px)';
/** True on phone-sized screens (<= 768px). */
export function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(MQ);
    const on = () => { setM(mq.matches); };
    mq.addEventListener('change', on);
    return () => { mq.removeEventListener('change', on); };
  }, []);
  return m;
}

/** Collapsible panel state. Desktop: persisted in localStorage `pgc.ui.<key>` (default open).
 *  Mobile: transient, closed by default (panels are overlay drawers). */
export function usePanel(key: string, mobile: boolean, desktopDefault = true): [boolean, (v: boolean | ((o: boolean) => boolean)) => void] {
  const lsKey = 'pgc.ui.' + key;
  const [desk, setDesk] = useState<boolean>(() => { try { const v = localStorage.getItem(lsKey); return v === null ? desktopDefault : v === '1'; } catch { return desktopDefault; } });
  const [mob, setMob] = useState(false);
  useEffect(() => { try { localStorage.setItem(lsKey, desk ? '1' : '0'); } catch { /* ignore */ } }, [lsKey, desk]);
  useEffect(() => { if (!mobile) { setMob(false); } }, [mobile]);
  return mobile ? [mob, setMob] : [desk, setDesk];
}
