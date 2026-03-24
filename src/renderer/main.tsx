import './polyfills';
import { installTauriBridge } from './tauriBridge';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// If running under Tauri, install the compatibility bridge
// that maps window.api.* → Tauri invoke() calls
installTauriBridge();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
