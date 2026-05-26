// Dev orchestrator: compiles main + preload, starts the Vite dev server,
// then spawns Electron pointing at the dev URL.
//
// Wired in task 1.2. Subsequent tasks (1.10, 1.14) will read
// `process.env.VITE_DEV_SERVER_URL` from `windows.ts` to decide between
// `loadURL(devUrl)` and `loadFile('dist/renderer/index.html')`.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import electronPath from 'electron';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function step(label) {
  // eslint-disable-next-line no-console
  console.log(`\n[dev] ${label}`);
}

// 1. Compile main + preload to dist/. Electron loads `dist/main/index.js`
//    (per package.json#main), so this must succeed before we spawn Electron.
step('compiling main + preload (tsc -p tsconfig.main.json)');
const tscResult = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-p', 'tsconfig.main.json'],
  { cwd: repoRoot, stdio: 'inherit', shell: true },
);
if (tscResult.status !== 0) {
  process.exit(tscResult.status ?? 1);
}

// 2. Start Vite dev server.
step('starting Vite dev server');
const server = await createServer({
  configFile: path.resolve(repoRoot, 'vite.config.ts'),
});
await server.listen();
server.printUrls();

const address = server.httpServer?.address();
const port =
  typeof address === 'object' && address && 'port' in address
    ? address.port
    : server.config.server.port ?? 5173;
const devUrl = `http://localhost:${port}`;

// 3. Spawn Electron with the dev URL injected via env.
step(`spawning Electron (VITE_DEV_SERVER_URL=${devUrl})`);
const electron = spawn(electronPath, ['.'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl,
    NODE_ENV: 'development',
  },
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close();
  } catch {
    // already closed
  }
  process.exit(code);
}

electron.on('exit', (code) => {
  void shutdown(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!electron.killed) electron.kill();
    void shutdown(0);
  });
}
