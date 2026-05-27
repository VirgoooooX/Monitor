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
    throw new Error('LOCALAPPDATA is not set; cannot locate electron-builder rcedit.');
  }

  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
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

  throw new Error(`Cannot find rcedit-x64.exe under ${cacheRoot}.`);
}

module.exports = async function afterPackIcon(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const rceditPath = findRcedit();

  await execFileAsync(rceditPath, [exePath, '--set-icon', iconPath], {
    windowsHide: true,
  });
};
