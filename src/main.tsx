import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initPacks } from './graph/packdb';
// knowledge packs load from IndexedDB before the first chat can run
initPacks().finally(() => { createRoot(document.getElementById('root')!).render(<App />); });
