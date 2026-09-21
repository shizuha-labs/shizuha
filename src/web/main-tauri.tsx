import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DesktopBoot } from './components/DesktopBoot';
import './globals.css';

function TauriApp() {
  const [ready, setReady] = useState(false);
  if (!ready) return <DesktopBoot onReady={() => setReady(true)} />;
  return <App />;
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <TauriApp />
    </React.StrictMode>,
  );
}
