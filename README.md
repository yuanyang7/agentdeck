# claude-web

A small web page for driving Claude Code conversations on this machine from any
other device on your Tailscale network.

Claude, your code, and the conversation history all stay on the host machine.
Other laptops or phones just open a web page. Every device sees the same live
conversation, including streaming replies and permission prompts, so you can
start something on one laptop and approve or continue it from another.

Conversations are the regular Claude Code sessions in `~/.claude/projects`, so
ones started in the terminal or the desktop app show up here too, and ones
started here can be resumed with `claude --resume`.

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
the same login).

### Options (environment variables)

| Variable        | Default                     | Meaning                                                      |
| --------------- | --------------------------- | ------------------------------------------------------------ |
| `PASSWORD`      | none                        | Require a password on top of Tailscale.                      |
| `PORT`          | `7878`                      | Port to listen on.                                           |
| `HOST`          | Tailscale IP, else 127.0.0.1 | Address to bind.                                            |
| `PROJECT_ROOTS` | `~/code`                    | `:`-separated folders whose subfolders appear as projects.   |

```bash
PASSWORD='something-long' npm start
```

## How turns work

- One conversation runs one turn at a time. While Claude is working, sending
  from another device is refused until the turn finishes or someone presses
  **Stop**. The lock releases itself when the turn ends, so taking turns across
  devices needs no extra step.
- Permission prompts (file edits, shell commands, plan approval, questions)
  appear on every connected device; whichever answers first wins.
- Pick the permission mode per message from the dropdown next to Send.
- Avoid having the same conversation open in this web UI *and* in a terminal or
  desktop-app Claude session at the same time: each process keeps its own copy
  in memory and they will not see each other's new messages.

## Keep it running (optional)

To start it at login and restart it if it crashes, use a LaunchAgent:

```bash
cat > ~/Library/LaunchAgents/com.claude-web.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-web</string>
  <key>ProgramArguments</key><array>
    <string>$(which node)</string><string>$(pwd)/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claude-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-web.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.claude-web.plist
```

Also make sure the host doesn't sleep while you're away (System Settings →
Energy → "Prevent automatic sleeping when the display is off").
