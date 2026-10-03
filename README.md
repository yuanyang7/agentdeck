# agentdeck

A small web page for driving coding-agent conversations (Claude Code, Codex
and opencode) on this machine from any other device on your Tailscale network.

The agents, your code, and the conversation history all stay on the host machine.
Other laptops or phones just open a web page. Every device sees the same live
conversation, including streaming replies and permission prompts, so you can
start something on one laptop and approve or continue it from another.

Conversations are each agent's own sessions: Claude Code's in
`~/.claude/projects`, Codex's in `~/.codex` and opencode's in its own store.
Ones started in the terminal or the desktop apps show up here too, and ones
started here can be resumed there (`claude --resume`, the Codex app or
`codex resume`, or the session list in opencode).

## Run

```bash
npm install
npm start
```

By default it listens on this machine's Tailscale IP (from `tailscale ip -4`),
port 7878, so it can only be reached from devices on your tailnet. On startup
it prints the address to open from other devices. Prefer the MagicDNS name
(`http://<machine-name>:7878`): it stays the same, and some browsers refuse or
try HTTPS on a bare `100.x` IP. Always type the `http://` prefix. It
also answers on `http://localhost:7878` on the host itself.

Requires Node 18+ and Claude Code being logged in on the host (the server uses
the same login). Codex and opencode are optional: each one that is installed
shows up as another agent and uses its own login. Codex runs on the Codex login
of this machine (your ChatGPT plan, or an API key); opencode uses its own
providers.

### Options (environment variables)

| Variable        | Default                     | Meaning                                                      |
| --------------- | --------------------------- | ------------------------------------------------------------ |
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

## Agents

The sidebar lists every agent's conversations for the project together, each
marked with its agent. When more than one agent is installed, a picker next to
the mode menu chooses the agent for a new conversation; an existing
conversation always continues with the agent it started with. The mode, model
and effort menus show what the chosen agent offers:

- **Claude Code**: its permission modes, models and effort levels. The
  **Usage** panel shows the plan limits of the Claude login.
- **Codex**: *Ask before actions* (asks before anything but known-safe
  reads), *Auto (sandboxed)* (Codex's default: works inside the project and
  asks to go beyond it), *Read only* and *Full access*. Models and effort
  levels are the ones your Codex login offers, and **Usage** shows the plan's
  Codex limits.
- **opencode**: *Ask before actions* runs opencode's `build` agent but asks
  before file edits and shell commands; the other modes are opencode's own
  agents (`build`, `plan`, …) with the permissions configured for them. Models
  are the ones from opencode's connected providers, and effort lists the
  selected model's variants.

For Codex and opencode the server starts a private `codex app-server` /
`opencode serve` the first time it is needed and stops it when the server
exits.

## Tags

Hover a conversation in the sidebar and click the tag button to edit its tags
(up to 10, 30 characters each). Type a tag and press Enter, or click one of your
**quick tags** to add or remove it. Every tag you apply is remembered as a quick
tag; the × next to a quick tag forgets it (chats keep the tags they already
have). Tags show under the chat, and a row of tag chips above the list filters
it. Everything is saved on the host in `~/.agentdeck/tags.json` (migrated
automatically from `~/.claude-web/tags.json` if you used an older release), so
every device sees the same tags and quick tags. They are not written into the
agents' transcripts.

## Images

Click the 📎 button, paste an image into the message box, or drag files onto
it to attach up to 10 PNG, JPEG, GIF or WebP images. Larger images are
downscaled in the browser before upload. Attached images show as thumbnails in
the conversation and can be sent with or without text.

## How turns work

- One conversation runs one turn at a time. While the agent is working, sending
  from another device is refused until the turn finishes or someone presses
  **Stop**. The lock releases itself when the turn ends, so taking turns across
  devices needs no extra step.
- Permission prompts (file edits, shell commands, plan approval, questions)
  appear on every connected device; whichever answers first wins.
- Pick the permission mode per message from the dropdown next to Send.
- Avoid having the same conversation open in this web UI *and* in a terminal,
  desktop-app or opencode TUI session at the same time: each process keeps its
  own copy in memory and they will not see each other's new messages.

## Code layout

- `server.mjs`: HTTP routes, login, projects.
- `lib/hub.mjs`: live conversations, the one-turn lock, permission prompts and
  the event stream every browser listens to. It doesn't depend on the agent.
- `lib/items.mjs`: the agent-neutral transcript format the page renders.
- `lib/agents/`: one adapter per agent (`claude.mjs`, `codex.mjs`,
  `opencode.mjs`). The
  interface they implement is described in `lib/agents/index.mjs`; adding an
  agent means adding a file there and listing it.

## Keep it running (optional)

To start it at login and restart it if it crashes, use a LaunchAgent:

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
should return `200`, and `lsof -nP -iTCP:7878 -sTCP:LISTEN` shows the running
process. Its output goes to `/tmp/agentdeck.log` when started as above or by
the LaunchAgent.
