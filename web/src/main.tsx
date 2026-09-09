import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import './styles.css';
import { DesignSystem } from './design-system';
import './design-system.css';

const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/design-system' ? <DesignSystem /> : <App />}
  </StrictMode>,
);
