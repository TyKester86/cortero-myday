import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { APP_URL, elsewhere, FEED_APP } from './apps';
import './styles.css';
import './feed.css';
import './social.css';
import './theme.css';
import './layout.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
// Offline reads + push. Production builds only (the dev server serves changing modules).
// The Feed app (its own domain) installs and gets push like MyDay. Never on another domain that only shows
// the Feed's public page (conquermyday.app/thefeed): the service worker would take over that site's other pages.
if ('serviceWorker' in navigator && import.meta.env.PROD && (FEED_APP || !elsewhere(APP_URL))) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
