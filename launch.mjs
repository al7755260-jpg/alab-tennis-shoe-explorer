import { spawn, execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function status(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) });
    if (!response.ok) return 'occupied';
    const data = await response.json();
    return data.app === 'tennis-shoe-explorer' ? 'ready' : 'occupied';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'available' : 'occupied'; }
}

async function launch() {
  for (let port = 4187; port <= 4197; port++) {
    let result = await status(port);
    if (result === 'occupied') continue;
    if (result === 'available') {
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: directory, env: { ...process.env, PORT: String(port) },
        detached: true, windowsHide: true, stdio: 'ignore',
      });
      child.unref();
      for (let i = 0; i < 30; i++) {
        await delay(100);
        result = await status(port);
        if (result === 'ready') break;
      }
    }
    if (result === 'ready') {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`ALAB shoe explorer: ${url}`);
      if (!process.argv.includes('--no-open')) {
        execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
      }
      return;
    }
  }
  throw new Error('Could not find a free local port between 4187 and 4197.');
}

launch().catch(error => { console.error(error.message); process.exitCode = 1; });
