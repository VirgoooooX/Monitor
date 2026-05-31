// Renderer entry.
//
// Loaded by `index.html` via `<script type="module" src="./main.tsx">`.
// Vite resolves the relative import to the bundled chunk and the
// production HTML is rewritten with the hashed asset path during
// `vite build`.
//
// The mount target (`#root`) is created in `index.html`. We assert
// its presence with a typed throw rather than `!` so that a future
// change to the HTML shell surfaces a precise error instead of an
// opaque "cannot read properties of null" at runtime.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { I18nProvider } from './lib/i18n';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error("Renderer mount target '#root' is missing from index.html");
}

// `<I18nProvider>` wraps `<App>` so every component in the tree can
// call `useT()` / `useLocale()` (i18n-multilingual-support task 10.2,
// Requirements 10.1, 10.2, 10.3). The provider seeds `DEFAULT_LOCALE`
// synchronously so first paint matches today's zh-CN copy; the
// `desktop.getSettings()` resolution and `settings.updated` push then
// drive Active_Locale changes without unmounting the React root or
// reloading the BrowserWindow (Requirement 7.4).
createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
