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
| `WORKSPACE_INDEX` | on                        | `off` stops giving agents the [workspace index](#workspace-index). |

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
limit. It only serves them to signed-in browsers when `PASSWORD` is set.

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

## Code layout

- `server.mjs`: HTTP routes, login, projects.
- `lib/hub.mjs`: live conversations, the one-turn lock, permission prompts
  and the event stream every browser listens to. It doesn't depend on the
  agent.
- `lib/items.mjs`: the agent-neutral transcript format the page renders.
- `lib/workspace-index.mjs`: the project map given to agents.
- `lib/folders.mjs`: a chat's extra folders: checking them and spotting
  projects a message names.
- `lib/commands.mjs`: reading a `/name` message and caching each folder's
  list of skills.
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
