# agentdeck reference

Detailed configuration and internals for agentdeck. Start with
[../README.md](../README.md) for the quick overview.

## Environment variables

| Variable        | Default                     | Meaning                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------ |
| `PASSWORD`      | none                        | A password that approves a browser, besides approval from another [device](#devices). |
| `ALLOWED_HOSTS` | none                        | `,`-separated extra host names the page may be opened under, besides IP addresses, `localhost` and the MagicDNS name (see [Devices](#devices)). |
| `PORT`          | `7878`                      | Port to listen on.                                           |
| `HOST`          | Tailscale IP, else 127.0.0.1 | Address to bind.                                            |
| `PROJECT_ROOTS` | `~/code`                    | `:`-separated folders whose subfolders appear as projects.   |
| `CODEX_BIN`     | newest of `codex` on `PATH` and the copies inside the ChatGPT / Codex apps | Codex binary to start. |
| `OPENCODE_BIN`  | `opencode` on `PATH`, else `~/.opencode/bin/opencode` | opencode binary to start.            |
| `OPENCODE_URL`  | none                        | Use an already running `opencode serve` instead of starting one (with `OPENCODE_SERVER_PASSWORD` if it has one). |
| `WORKSPACE_INDEX` | on                        | `off` stops giving agents the [workspace index](#workspace-index). |
| `AGENTDECK_SUPERVISED` | detected               | `1` if something restarts agentdeck when it exits, `0` if nothing does; see [Quick actions](#quick-actions). |

```bash
PASSWORD='something-long' npm start
```

## Devices

Each browser has to be approved once before it can use agentdeck:

1. A browser the host doesn't know gets a random device key in a cookie and
   shows a six-character code, such as `K7Q-4MD`.
2. Every approved device shows a **New device** card with the browser's kind
   (*Safari on iPhone*) and the tailnet machine it comes from, as Tailscale
   names it. The card doesn't show the code: type the code from the new
   device's screen and press **Approve**. Only the waiting browser is ever
   shown its code, so a request you can't see, made by someone else, can't
   be approved by tapping through. A wrong code is refused and the request
   keeps waiting. **Deny** shows that device a denial and an **Ask again**
   button, which starts over with a new code.
3. Once approved, the waiting page opens agentdeck by itself.

The first device has no one to approve it, so approve it from a terminal on
the host:

```bash
npm run approve              # lists waiting devices and asks for the code
npm run approve -- K7Q-4MD   # approves the device showing that code
```

This talks to the running server on `127.0.0.1` (set `PORT` if you changed
it) using `~/.agentdeck/host-key`, a random key readable only by your user.
With `PASSWORD` set, typing it on the waiting page approves that browser too.
After five wrong passwords from one address, that address can't try again
for up to ten minutes.

A request lapses after ten minutes, and at most five can wait at once.
Approved devices are kept in `~/.agentdeck/devices.json`, readable only by
your user. The file stores a hash of each key, not the key itself, with a
name, the machine, and when the device was added and last used. The cookie
lasts 400 days (the most browsers allow) and is renewed on every visit.
**Devices**, at the bottom of the sidebar, lists approved devices.
**Remove** cuts that device off at once: its open pages say it was removed,
with **Ask again** to request approval anew. A web app added to an iPhone home screen has its own cookies, so it
counts as a separate device. To start over, stop agentdeck, delete
`devices.json`, and approve again.

agentdeck doesn't treat requests from `localhost` as trusted, because with
`tailscale serve` every request arrives from there. It also refuses two kinds
of request that a web page could make through your own browser:

- **Cross-site requests.** A page from another site, or from another port of
  the same host (a dev server on `localhost:3000`, say), can't call the API.
  Browsers mark such requests with `Sec-Fetch-Site` (or `Origin`).
- **DNS rebinding.** A site could point its own domain at this machine to
  get past the browser's same-origin rule. Only this machine's own names are
  accepted: IP addresses, `localhost`, and its MagicDNS name, both full (as
  `tailscale serve` uses it) and short. If Tailscale wasn't up when agentdeck
  started, the name is looked up again, at most once a minute, the first
  time a request uses it. If you reach agentdeck under any other name, such
  as a `.local` name on your LAN, add it to `ALLOWED_HOSTS`.

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

## Skills

The `/` menu lists what the chat's agent offers in the project folder. Each
list is fetched at most once a minute, so a skill added on disk shows up
within a minute. A message that starts with `/name` runs it:

- **Claude Code**: everything its own `/` menu has, i.e. skills and commands
  from `~/.claude`, the project's `.claude` folder, plugins and claude.ai,
  plus built-in commands such as `/compact`, `/context` and `/code-review`.
  The message goes to Claude Code as typed, and Claude Code runs it. The
  menu leaves out commands that only work in a terminal (Claude Code names
  them once a turn has run since agentdeck started) and `/model`, `/effort`
  and `/clear`, whose jobs the model and effort pickers and New
  conversation do. History shows the command as typed, followed by
  whatever a command like `/compact` printed.
- **Codex**: the skills Codex finds for the folder (`skills/list`). Its
  slash commands belong to its terminal UI, so there are none here. `/name`
  is sent the way Codex's own apps send a skill: as `$name` in the text plus
  the skill itself, which loads its instructions into the turn. The message
  then shows as `$name …`.
- **opencode**: its commands (the project's and your own, MCP prompts, and
  opencode's `/init` and `/review`) and its skills. A command runs on the
  opencode server, which fills its template into the prompt. The message
  shows as typed while the turn runs, but history shows the filled-in
  prompt. A skill is sent as an attachment to the message.

## Tags

Tags are saved on the host in `~/.agentdeck/tags.json` (migrated
automatically from `~/.claude-web/tags.json` if you used an older release),
so every device sees the same tags and quick tags.

## Forks

Each agent copies a conversation itself, so a branch is one of its own
sessions and opens in a terminal or desktop app like any other:

- **Claude Code**: the SDK's `forkSession`, cut at the forked turn's last
  transcript entry. The copy is named after the chat it came from, with
  `(fork)` appended, and starts without undo history (Claude Code does not
  copy file-history snapshots into a fork).
- **Codex**: `thread/fork` with the `lastTurnId` of the forked turn. An
  app-server too old for a fork point copies the whole thread instead, and
  the page says so in the new conversation.
- **opencode**: `POST /session/{id}/fork` with `before` set to the next
  message, which is opencode's own "copy the history before this message".

The branch also gets the model, effort, permission mode and tags of the chat
it came from, which are agentdeck's own records rather than the agent's.
Forking is refused while a turn is running, because the transcript is still
being written, and a conversation whose project folder no longer exists
cannot be forked.

## Workspace index

When agentdeck starts a new conversation, it gives the agent a short map of
the projects on this machine, built from what the sidebar knows:

- every folder directly under `PROJECT_ROOTS`, most recently active first
  (at most 60), with its path and the date of its last chat;
- the first paragraph of its README, or `package.json`'s description,
  clipped to 160 characters;
- the titles of its three latest chats across Claude Code, Codex and
  opencode, and up to six subfolders that have chats of their own.

Chats in a subfolder count toward the top-level project. Worktrees and
other dot-folders are left out of the subfolder list, and so are folders
outside the project roots (scratch folders, the home directory). With 45
projects the index is about 9 KB, roughly 2,000 tokens.

How each agent receives it:

- **Claude Code**: appended to its system prompt (`systemPrompt.append`).
- **Codex**: as `developerInstructions` on `thread/start`, after any
  `developer_instructions` in the Codex config (global or the project's),
  which the parameter would otherwise replace.
- **opencode**: as an instruction entry on the session
  (`PUT /api/experimental/session/{id}/instructions/entries/workspace-index`).
  opencode v2 does not read the config's `instructions` files. This API is
  experimental; if it fails, the chat goes on without the index.

Each agent records the index when the conversation is created and keeps it
for the rest of the conversation: Claude Code saves its system prompt with
the session, and Codex ignores developer instructions on resume. So a chat
sees the projects as they were when it started and its prompt cache stays
valid. Continuing an existing chat, including ones from before this feature
or started in a terminal, adds nothing. Two exceptions on Claude Code: the
recorded prompt is rebuilt when a conversation is compacted, and recording
is still rolling out (and does nothing on Bedrock, Vertex or Foundry).
agentdeck only keeps a chat's index in memory, so in those cases a chat
continued after agentdeck restarts loses the index.

Chat titles are often the start of a chat's first message (Claude Code and
Codex fall back to it when a chat has no summary), so the index carries the
opening words of chats from every project to the provider of each new chat,
including whatever provider opencode is set up with. Set
`WORKSPACE_INDEX=off` if that matters. The index only tells the agent where
to look. Access to another project comes from the chat's
[extra folders](#extra-folders).

## Extra folders

Besides its own folder, a chat can have up to 10 extra folders that the
agent may read and edit without asking for access first. You can add them in
two ways:

- **The 📁 button** in the composer, which lists the folders directly under
  `PROJECT_ROOTS` and also takes any absolute path. In an open chat a
  change is saved right away and applies from the next message. For a new
  chat it goes with the first message.
- **Naming a project in a message.** Before the turn starts, the server
  looks for the names of folders directly under `PROJECT_ROOTS` in the
  message. A name only counts as a whole word, so `mini-games` doesn't match
  inside `mini-games-hub`, and names shorter than three characters are
  ignored. A path counts too, since it contains the name. If the message
  names projects the chat can't reach yet, a prompt on every device asks
  whether to add them, and the turn waits for the answer. Each project is
  asked about once per chat, and Stop cancels the turn while the prompt is
  waiting. Allowed folders also go to messages already queued behind it.
  Nothing is asked in modes that already allow everything (Claude Code's
  *Bypass permissions*, Codex's *Full access*).

The folders are stored with the chat's model, effort and mode in
`~/.agentdeck/chat-settings.json`, and forks inherit them. A folder that no
longer exists stops the chat from sending until it is removed. Each agent
gets the folders on every turn:

- **Claude Code**: `additionalDirectories`, the SDK's version of `--add-dir`.
  Reading there needs no approval, and *Auto-accept edits* covers edits
  there too.
- **Codex**: extra `writableRoots` in the *Ask before actions* and *Auto*
  sandboxes. Codex can already read anywhere, so this lets it write there
  without asking to leave the sandbox. *Read only* stays read-only.
- **opencode**: an `external_directory` allow rule for each folder (and its
  resolved path) on the session's permissions. *Ask before actions* still
  asks before edits and shell commands there.

Folders under `/tmp` don't show a difference for Codex: its sandbox lets it
write to `/tmp` anyway.

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
- Videos work the same way: a markdown image pointing at an `.mp4`, `.m4v`,
  `.mov` or `.webm` file (`![demo](/tmp/demo.mp4)`), or a reply that names
  one, gets an inline player. The server streams videos with byte ranges, so
  seeking works and Safari plays them. Whether a format plays depends on the
  browser (`.mov` is reliable only in Safari).
- Audio works the same way, with a compact player: `.mp3`, `.m4a`, `.aac`,
  `.wav`, `.ogg`, `.oga`, `.opus` and `.flac` files linked as markdown images
  (`![voice](out/take.mp3)`) or named in a reply. Sound clips a tool returns
  directly (MCP `audio` content in Codex, audio attachments in opencode) play
  under the tool card. A `.webm` always gets a video player, even when it only
  holds audio.

Larger images are downscaled in the browser before upload. The server only
serves files with an image extension (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP;
up to 50 MB), a video extension (MP4, M4V, MOV, WebM) or an audio extension
(MP3, M4A, AAC, WAV, Ogg, OGA, Opus, FLAC); videos and audio have no size
limit. It only serves them to approved browsers.

## Sounds

Two chimes, synthesized in the browser (there's no audio file to load):

- A turn finishing: E5 → B5, soft.
- An approval request arriving: A5 twice, more insistent.

Both follow every conversation the server reports, not just the open one, and
nothing sounds for streamed text as it arrives or for messages you send. The
bell button in the header mutes them; the choice is stored per device
(`cw_sound` in the browser's local storage) and isn't synced like tags or
model settings are.

Browsers block audio until the page has been interacted with, and suspend it
again when a phone locks or a tab sleeps, so every click and key press on the
page wakes the sound up. A page that has only ever been scrolled stays silent.

## Quick actions

The buttons at the right end of the header. **Restart** is built in; the
others come from **Settings** in the sidebar footer and are kept in
`~/.agentdeck/actions.json` (`{ actions: [{ id, icon, label, command,
restart }] }`), so every device shows the same ones. At most 12, with labels
of up to 24 characters and commands of up to 1,000. Each command runs
through `$SHELL -c` (else `/bin/sh`) in the folder of the workspace open on
the page that pressed it, with the server's environment plus
`AGENTDECK_DIR` (agentdeck's own folder) and `AGENTDECK_PORT`. It gets 60
seconds, after which its whole process group is killed, and its output (both
streams, up to 100 KB) comes back to the page that pressed the button as a
card above the composer. The exit code decides whether the card is marked
failed. An action with *Restart agentdeck when it succeeds* restarts after
an exit code of 0.

A restart stops every running turn, since agents run inside the server. So
`POST /api/actions/run` answers `409` with the number of running turns
unless `force` is set, and the page asks before sending it again; if turns
started while a command ran, the restart is skipped and the card says so.
The server then tells every page (`restarting` event), waits 300 ms and
exits. How it comes back depends on how it was started:

- Under the [LaunchAgent](#keeping-it-running-launchagent) (or systemd, or
  pm2) the supervisor starts it again. On macOS this is detected by asking
  `launchctl list` whether the server's own pid is a job, rather than by
  reading the environment, because everything an agent runs inside agentdeck
  inherits that environment.
- Started by hand (`npm start`, `node server.mjs`, with or without `nohup`),
  it starts itself again: a detached shell waits for the old process to end,
  which frees the port, then runs the same command in the same folder with
  the same environment and output. A terminal that ran `npm start` in the
  foreground gets its prompt back while the new server keeps printing there.

`AGENTDECK_SUPERVISED=1` or `0` overrides the detection. Pages poll
`/api/me` until a process with a different `since` answers, then reload, so
they also get any new page code; the composer's text is kept across the
reload in session storage. Anyone who can use agentdeck can run these
commands, which is no more than an agent in a bypass mode can already do;
the same device approval and same-site checks apply.

## Code layout

- `server.mjs`: HTTP routes, device approval checks, projects.
- `lib/devices.mjs`: approved devices and the requests waiting for approval.
- `approve.mjs`: `npm run approve`, approving a device from the host's terminal.
- `lib/hub.mjs`: live conversations, the one-turn lock, permission prompts
  and the event stream every browser listens to. It doesn't depend on the
  agent.
- `lib/items.mjs`: the agent-neutral transcript format the page renders.
- `lib/workspace-index.mjs`: the project map given to agents.
- `lib/folders.mjs`: a chat's extra folders: checking them and spotting
  projects a message names.
- `lib/commands.mjs`: reading a `/name` message and caching each folder's
  list of skills.
- `lib/actions.mjs`: the quick-action buttons; the restart itself is in
  `server.mjs`.
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

**Restarting from inside agentdeck.** Asking an agent in agentdeck to
restart the server, or to rename the project folder, stops the conversation
doing the work, because that conversation runs inside the server. Let the
agent finish its change, then press **Restart** in the header yourself (see
[Quick actions](#quick-actions)); it waits for your go-ahead if turns are
still running. Renames still need a terminal on the host.

**Checking whether it's up.** On the host, `curl -i http://localhost:7878/`
should return `200`, and `lsof -nP -iTCP:7878 -sTCP:LISTEN` shows the
running process. Its output goes to `/tmp/agentdeck.log` when started as
above or by the LaunchAgent.
