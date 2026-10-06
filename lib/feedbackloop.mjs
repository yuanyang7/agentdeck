// feedback-loop (~/code/feedback-loop): bug reports become GitHub issues that
// an agent triages and fixes, stopping at a pull request. When the open
// workspace is enrolled, the project bar shows its bug queue, links to the
// feedback dashboard and can file a report. Without the CLI, or in a folder
// that isn't enrolled, nothing shows.
//
// A folder is enrolled when it, or a parent inside the same git repository,
// has `.feedback-loop/config.yml`. Everything goes through the CLI:
// `status <dir> --json` for the queue (kept 60 s, then refreshed in the
// background, so only the first ask for a folder waits) and `report <dir>`
// to file one. FEEDBACK_LOOP=off disables it; FEEDBACK_LOOP_BIN names the CLI
// when it isn't on PATH or in /opt/homebrew/bin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const enabled = (process.env.FEEDBACK_LOOP || '').trim().toLowerCase() !== 'off';

const FRESH = 60_000;
const DASHBOARD_PORT = 7777; // `feedback-loop dashboard`'s default

// The CLI and the node it runs on (a LaunchAgent's PATH may have neither),
// plus `gh`, which it calls.
const searchPath = [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))];
const childEnv = { ...process.env, PATH: searchPath.join(':'), NO_COLOR: '1' };

// How to run feedback-loop, or null when it isn't installed. Its launcher is a
// node script, so it runs on this node rather than whatever `env node` finds.
function command() {
  const candidates = process.env.FEEDBACK_LOOP_BIN ? [process.env.FEEDBACK_LOOP_BIN] : searchPath.map((d) => path.join(d, 'feedback-loop'));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      const real = fs.realpathSync(c);
      return /\.[cm]?js$/.test(real) ? [process.execPath, real] : [real];
    } catch {}
  }
  return null;
}

export const available = () => enabled && command() !== null;

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The enrolled folder for `dir`: the nearest one at or above it with
// `.feedback-loop/config.yml`. The walk stops at a git root, so a repository
// nested inside an enrolled one isn't taken for part of it.
export function enrolledRoot(dir) {
  for (let d = realpath(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.feedback-loop', 'config.yml'))) return d;
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return null;
  }
}

function run(args, cwd, timeout) {
  const cmd = command();
  if (!cmd) return Promise.reject(new Error('feedback-loop is not installed.'));
  return new Promise((resolve, reject) => {
    execFile(cmd[0], [...cmd.slice(1), ...args], { cwd, env: childEnv, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const said = `${stderr || stdout}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      reject(new Error(err.killed ? 'feedback-loop took too long.' : said || err.message));
    });
  });
}

const cache = new Map(); // enrolled folder -> { at, value, pending }

async function fetchStatus(root) {
  try {
    const s = JSON.parse(await run(['status', root, '--json'], root, 45_000));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

// `feedback-loop status --json` for an enrolled folder, or null when it
// couldn't be read. A stale answer is served while a fresh one is fetched.
export function status(root) {
  let c = cache.get(root);
  if (!c) cache.set(root, (c = { at: 0, value: null, pending: null }));
  if (Date.now() - c.at >= FRESH && !c.pending) {
    c.pending = fetchStatus(root).then((value) => {
      Object.assign(c, { at: Date.now(), value, pending: null });
      return value;
    });
  }
  return c.at ? Promise.resolve(c.value) : c.pending;
}

// The target's dashboard: the config's `dashboard.url`, else
// `feedback-loop dashboard --all` on its default port. Either way a loopback
// name becomes the one the page used, since the dashboard, like agentdeck,
// listens on the Tailscale address.
export function dashboardUrl(s, host) {
  if (!s?.target) return '';
  try {
    const u = new URL(s.dashboardUrl || `http://localhost:${DASHBOARD_PORT}/${encodeURIComponent(s.target)}/`);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) u.hostname = host;
    return u.href;
  } catch {
    return '';
  }
}

// Files a report and answers `{ number, url, target }`. `ready` applies
// `agent-ready`, the label that lets the loop start on it unasked. The body
// goes through a file: the CLI reads any argument starting with `--` as a
// flag.
export async function report(root, { title, body, severity, ready }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-report-'));
  try {
    const bodyFile = path.join(tmp, 'body.md');
    fs.writeFileSync(bodyFile, body);
    const args = ['report', root, '--title', title, '--body-file', bodyFile, '--severity', severity, '--source', 'agentdeck', '--json'];
    if (ready) args.push('--ready');
    const out = await run(args, root, 120_000);
    cache.delete(root); // the queue changed
    let filed = null;
    try {
      filed = JSON.parse(out.trim().split('\n').pop());
    } catch {}
    if (!filed?.number) throw new Error(`Unexpected answer from feedback-loop: ${out.trim().slice(0, 300)}`);
    return filed;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
