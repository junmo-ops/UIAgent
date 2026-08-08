import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';
import { WorkspaceManagerApp } from '../../src/workspaces/WorkspaceManagerApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WorkspaceManagerApp /></React.StrictMode>
);
