import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/inter';
import './styles.css';

// Drop the FOUC-prevention inline background set in index.html so subsequent
// theme toggles flow through var(--bg) instead of being overridden by it.
document.documentElement.style.background = '';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
