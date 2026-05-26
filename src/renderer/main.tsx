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
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error("Renderer mount target '#root' is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
