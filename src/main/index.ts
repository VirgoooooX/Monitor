// Electron main-process bootstrap. Delegates the full boot sequence
// to `./app#main` (task 1.14). This file is the entry point named by
// `package.json#main` (`dist/main/index.js`); keeping it as a thin
// trampoline means future packaging tweaks only need to touch one
// file.

import { main } from './app';

main();
