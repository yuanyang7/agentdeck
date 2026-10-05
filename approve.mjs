// Approves a browser that is waiting to use agentdeck, from a terminal on the
// host. This is how the first device gets in; after that, any approved device
// can approve the next one. Either way you type the code the new browser
// shows, which nothing else displays.
//
//   npm run approve              lists waiting devices and asks for the code
//   npm run approve -- K7Q-4MD   approves the device showing that code

import readline from 'node:readline/promises';
import { hostKey } from './lib/devices.mjs';

const PORT = Number(process.env.PORT || 7878);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = hostKey();

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : `${m} min ago`;
};
const describe = (r) => `${r.name}${r.machine ? ` · ${r.machine}` : ''}`;

async function approve(code) {
  const { device } = await api('/api/devices/approve', { code });
  console.log(`Approved ${describe(device)}. It opens agentdeck in a moment.`);
}

async function main() {
  const typed = process.argv[2];
  let waiting;
  try {
    ({ waiting } = await api('/api/devices'));
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error(`agentdeck isn't running on port ${PORT}. Start it first (npm start), or set PORT.`);
    } else {
      console.error(`Could not reach agentdeck: ${err.message}`);
    }
    process.exit(1);
  }
  if (typed) return approve(typed);
  if (!waiting.length) {
    console.log('No device is waiting. Open agentdeck in the browser you want to approve; it shows a code. Then run this again.');
    return;
  }
  console.log('Waiting for approval:');
  for (const r of waiting) console.log(`  ${describe(r)} · ${ago(r.at)}`);
  if (!process.stdin.isTTY) {
    console.log('\nApprove one with: npm run approve -- <the code it shows>');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question('\nType the code shown on the device to approve it (Enter to cancel): ').catch(() => ''); // Ctrl+D: cancel
  rl.close();
  if (code.trim()) await approve(code);
  else console.log('Not approved.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
