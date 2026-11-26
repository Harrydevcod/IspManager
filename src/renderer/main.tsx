import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { reportReactError } from './lib/error-reports';
import { initializeMobileTransport, type MobileBridge } from './lib/mobileBootstrap';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

initializeMobileTransport(window.location.origin, (window as Window & {ispmMobile?: MobileBridge}).ispmMobile);

// Drop the FOUC-prevention inline background set in index.html so subsequent
// theme toggles flow through var(--bg) instead of being overridden by it.
document.documentElement.style.background = '';

createRoot(document.getElementById('root') as HTMLElement, {
  onUncaughtError: reportReactError,
  onCaughtError: reportReactError
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
