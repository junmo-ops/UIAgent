import React from 'react';
import ReactDOM from 'react-dom/client';
import 'antd/dist/reset.css';
import './style.css';
import { SidePanelApp } from '../../src/sidepanel/SidePanelApp';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><SidePanelApp /></React.StrictMode>);
