import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './feed.css';
import './social.css';
import './theme.css';
import './layout.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
// Offline reads + push. Production builds only (the dev server serves changing modules).
// Never on another domain that only shows the Feed's public page (conquermyday.app/feed): the app's
// service worker would take over that site's other pages.
const appUrl = document.querySelector<HTMLMetaElement>('meta[name="myday-app-url"]')?.content;
const elsewhere = !!appUrl && new URL(appUrl).origin !== location.origin;
if ('serviceWorker' in navigator && import.meta.env.PROD && !elsewhere) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
