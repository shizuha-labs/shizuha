import React from 'react';
import ReactDOM from 'react-dom/client';
import CoreHealthView from './components/CoreHealth';
import './globals.css';

function TauriApp() {
  return (
    <div className="min-h-screen bg-gray-50">
      <CoreHealthView />
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <TauriApp />
    </React.StrictMode>,
  );
}
