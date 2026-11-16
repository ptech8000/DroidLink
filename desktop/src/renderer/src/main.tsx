import React from 'react';
import ReactDOM from 'react-dom/client';
import { installWebDroidLinkShim } from './web-shim';
import { App } from './App';
import './index.css';

installWebDroidLinkShim();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
