// Clipper postinstall — make the native bits match Electron, not system Node.
// - Downloads the Electron binary if its own postinstall was skipped.
// - Fetches the better-sqlite3 prebuild compiled for Electron's ABI, so the
//   app never hits "compiled against a different Node.js version" at launch.
// Fail-soft by design: any error here is ignored so `npm install` never
// breaks because of this script. The one-click setup files
// ("Clipper Setup.command" / "Clipper Setup.bat") retry the same steps.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

try {
  const root = path.join(__dirname, '..');
  const electronDir = path.join(root, 'node_modules', 'electron');

  if (fs.existsSync(electronDir) && !fs.existsSync(path.join(electronDir, 'path.txt'))) {
    run(process.execPath, [path.join(electronDir, 'install.js')], root);
  }

  const bsDir = path.join(root, 'node_modules', 'better-sqlite3');
  if (fs.existsSync(bsDir) && fs.existsSync(electronDir)) {
    const ev = require(path.join(electronDir, 'package.json')).version;
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    run(npx, ['--yes', 'prebuild-install', '--runtime', 'electron', '--target', ev], bsDir);
  }
} catch {
  // Never fail the install.
}
