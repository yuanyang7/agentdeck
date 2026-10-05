# agentdeck reference

Detailed configuration and internals for agentdeck. Start with
[../README.md](../README.md) for the quick overview.

## Environment variables

| Variable        | Default                     | Meaning                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------ |
| `PASSWORD`      | none                        | Require a password on top of Tailscale.                      |
| `PORT`          | `7878`                      | Port to listen on.                                           |
| `HOST`          | Tailscale IP, else 127.0.0.1 | Address to bind.                                            |
| `PROJECT_ROOTS` | `~/code`                    | `:`-separated folders whose subfolders appear as projects.   |
| `CODEX_BIN`     | newest of `codex` on `PATH` and the copies inside the ChatGPT / Codex apps | Codex binary to start. |
| `OPENCODE_BIN`  | `opencode` on `PATH`, else `~/.opencode/bin/opencode` | opencode binary to start.            |
| `OPENCODE_URL`  | none                        | Use an already running `opencode serve` instead of starting one (with `OPENCODE_SERVER_PASSWORD` if it has one). |

```bash
PASSWORD='something-long' npm start
```

## Agent modes

The mode, model and effort menus show what the chosen agent offers:

- **Claude Code**: its permission modes, models and effort levels. The
  **Usage** panel shows the plan limits of the Claude login.
- **Codex**: *Ask before actions* (asks before anything but known-safe
  reads), *Auto (sandboxed)* (Codex's default: works inside the project and
  asks to go beyond it), *Read only* and *Full access*. Models and effort
  levels are the ones your Codex login offers, and **Usage** shows the
  plan's Codex limits.
- **opencode**: *Ask before actions* runs opencode's `build` agent but asks
  before file edits and shell commands; the other modes are opencode's own
  agents (`build`, `plan`, …) with the permissions configured for them.
  Models are the ones from opencode's connected providers, and effort lists
  the selected model's variants.

For Codex and opencode the server starts a private `codex app-server` /
`opencode serve` the first time it is needed and stops it when the server
exits.

## Tags

Tags are saved on the host in `~/.agentdeck/tags.json` (migrated
automatically from `~/.claude-web/tags.json` if you used an older release),
so every device sees the same tags and quick tags.

## Images

- Pictures a tool returns, such as Claude reading a PNG, a browser or
  screenshot tool, Codex's image viewer and image generation, or opencode
  reading an image, appear under the tool card and stay visible while the
  card is collapsed.
- Images in a reply's markdown that point at files on the host (an absolute
  path, a `file://` URL, or a path relative to the project) are loaded
  through the server, so they also display on other devices.
- Image files a reply only mentions by name, such as `web-1-entry.png` or
  `/tmp/shots/home.png`, get thumbnails under the paragraph or list item
  that mentions them. A bare file name is matched against the paths the
  agent's tools used earlier in the conversation; a path with a folder is
  taken relative to the project. Names that don't lead to an existing image
  are left as plain text.

Larger images are downscaled in the browser before upload. The server only
serves files with an image extension (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP;
up to 50 MB), and only to signed-in browsers when `PASSWORD` is set.

## Code layout

- `server.mjs`: HTTP routes, login, projects.
- `lib/hub.mjs`: live conversations, the one-turn lock, permission prompts
  and the event stream every browser listens to. It doesn't depend on the
  agent.
- `lib/items.mjs`: the agent-neutral transcript format the page renders.
- `lib/agents/`: one adapter per agent (`claude.mjs`, `codex.mjs`,
  `opencode.mjs`). The interface they implement is described in
  `lib/agents/index.mjs`; adding an agent means adding a file there and
  listing it.

## Keeping it running (LaunchAgent)

To start agentdeck at login and restart it if it crashes, use a LaunchAgent:

```bash
cat > ~/Library/LaunchAgents/com.agentdeck.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentdeck</string>
  <key>ProgramArguments</key><array>
    <string>$(which node)</string><string>$(pwd)/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agentdeck.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentdeck.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.agentdeck.plist
```

Also make sure the host doesn't sleep while you're away (System Settings →
Energy → "Prevent automatic sleeping when the display is off").

## Troubleshooting

**Every page returns a 500 error mentioning a path that doesn't exist.** The
server keeps the absolute path of the folder it was started from. If that
folder is renamed or moved while the server is running (for example
`~/code/claude-web` → `~/code/agentdeck`), requests fail with
`ENOENT ... <old path>/public/index.html`. Restart the server from the new
location:

```bash
pkill -f 'node server.mjs'; cd ~/code/agentdeck && nohup npm start > /tmp/agentdeck.log 2>&1 &
```

With the LaunchAgent, update the paths in the plist, then
`launchctl unload` and `launchctl load` it again.

**Restarting from inside agentdeck.** Asking an agent in agentdeck to rename
the project folder or restart the server stops the conversation doing the
work, because that conversation runs inside the server. Make changes like
these from a terminal on the host.

**Checking whether it's up.** On the host, `curl -i http://localhost:7878/`
should return `200`, and `lsof -nP -iTCP:7878 -sTCP:LISTEN` shows the
running process. Its output goes to `/tmp/agentdeck.log` when started as
above or by the LaunchAgent.
