const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function findRcedit() {
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) {
    return null;
  }

  const entries = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(cacheRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of entries) {
    const candidate = path.join(entry.fullPath, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

module.exports = async function afterPackIcon(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const rceditPath = findRcedit();
  if (!rceditPath) {
    // electron-builder only populates the winCodeSign cache when it
    // actually needs to sign / edit the executable. On hosted CI
    // runners with `signAndEditExecutable: false` the cache is never
    // pulled, so rcedit isn't available. The NSIS installer's icon
    // is already wired via `win.icon` in electron-builder.yml; the
    // explicit rcedit pass here is a belt-and-braces for local dev
    // builds. Skipping it on CI is safe.
    console.log(
      '[after-pack-icon] rcedit not found; skipping post-pack icon embed (electron-builder.yml#win.icon already covers it).',
    );
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

  await execFileAsync(rceditPath, [exePath, '--set-icon', iconPath], {
    windowsHide: true,
  });
};
