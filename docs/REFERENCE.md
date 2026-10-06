# agentdeck reference

Detailed configuration and internals for agentdeck. Start with
[../README.md](../README.md) for the quick overview.

## Environment variables

| Variable        | Default                     | Meaning                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------ |
| `PASSWORD`      | none                        | A password that approves a browser, besides approval from another [device](#devices). |
| `ALLOWED_HOSTS` | none                        | `,`-separated extra host names the page may be opened under, besides IP addresses, `localhost` and the MagicDNS name (see [Devices](#devices)). |
| `CANONICAL_HOST` | MagicDNS name              | The one name the page is opened under, so each browser is approved once (see [Devices](#devices)). A name uses that one; `off` serves the page under every name. |
| `PORT`          | `7878`                      | Port to listen on.                                           |
| `HOST`          | Tailscale IP, else 127.0.0.1 | Address to bind.                                            |
| `PROJECT_ROOTS` | `~/code`                    | `:`-separated folders whose subfolders appear as projects.   |
| `CODEX_BIN`     | newest of `codex` on `PATH` and the copies inside the ChatGPT / Codex apps | Codex binary to start. |
| `OPENCODE_BIN`  | `opencode` on `PATH`, else `~/.opencode/bin/opencode` | opencode binary to start.            |
| `OPENCODE_URL`  | none                        | Use an already running `opencode serve` instead of starting one (with `OPENCODE_SERVER_PASSWORD` if it has one). |
| `WORKSPACE_INDEX` | on                        | `off` stops giving agents the [workspace index](#workspace-index). |
| `ROUTE_MODEL`   | `sonnet`                    | Model that picks the project for [Just ask](#just-ask); any name Claude Code's `--model` accepts. |
| `AGENTDECK_SUPERVISED` | detected               | `1` if something restarts agentdeck when it exits, `0` if nothing does; see [Quick actions](#quick-actions). |
| `TOOL_HUB_URL`  | `http://127.0.0.1:8765`     | Where [Tool Hub](#tool-hub) answers, for the project bar; `off` disables it. |
| `FEEDBACK_LOOP` | on                          | `off` hides the [feedback-loop](#feedback-loop) entries in the project bar. |
| `FEEDBACK_LOOP_BIN` | `feedback-loop` on `PATH`, else in `/opt/homebrew/bin` or `/usr/local/bin` | feedback-loop CLI to run. |

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

### One name per browser

Browsers keep cookies per host name, so the same browser is a different
device under `http://100.x.y.z:7878` than under
`http://machine.tail-name.ts.net:7878`, and opening agentdeck under both
means approving it twice. So the page is sent to one name — the MagicDNS
name, as the startup banner prints it — whatever name it was opened under,
including `localhost` on the host. Only the page moves: files, the API and
`npm run approve` answer under any name, which is why a `302` can't cut off
a device mid-chat.

`CANONICAL_HOST` is that name. Set it to another name of this machine's to
use that one instead (behind `tailscale serve`, say, where requests already
arrive under the full MagicDNS name), or to `off` to serve the page under
every name and approve each one separately. Names in `ALLOWED_HOSTS` are
never redirected, since they were added on purpose — a `.local` name for a
device off the tailnet, for instance, where the MagicDNS name wouldn't
resolve. For a device that can't resolve it either, `?stay`
(`http://100.x.y.z:7878/?stay`) opens the page under the name as typed.

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
  before file edits and shell commands. *Auto* runs `build` and automatically
  approves permission requests unless opencode explicitly denies them. The
  other modes are opencode's own agents (`build`, `plan`, …) with their
  configured permissions.
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

## Moving a chat

`POST /api/move { agent, sessionId, dir, to, confirmed: true }` moves a chat
from its folder `dir` to the existing folder `to`. It only runs on the user's
say-so: the page's dialog names the chat and both folders and sends
`confirmed` when Move is pressed, and the server refuses a request without
it. Nothing moves a chat on its own. It is also refused while a turn is
running, here or (as far as the agent can tell) in another app. Every agent keeps a chat's folder in its own store, so each moves it
its own way:

- **Claude Code** looks a chat up only in the project folder named after its
  folder (`~/.claude/projects/<path with dashes>`), so the transcript moves
  there with the folder in each entry rewritten to `to`, and the folder of
  subagent transcripts and tool results beside it goes along. A copy of the
  transcript as it was is kept in `~/.agentdeck/moved/<time>/` first. The id
  stays the same.
- **Codex** indexes a rollout file by byte offset, so the file can't be
  edited (an edited rollout stops saving new turns). The chat is forked with
  `thread/fork` and the new `cwd`, which keeps the whole history, and the
  original is archived with `thread/archive`, which the Codex app can undo.
  The moved chat has a new id; its tags and settings go with it. Codex lists
  a fork only once a message is sent in it, so until then agentdeck lists it
  from `~/.agentdeck/codex-moved.json`.
- **opencode** moves a session itself: `POST /session/{id}/move` with the new
  directory. The id stays the same.

After a turn, any folder directly under the project roots made since the
turn started (other than the chat's own) comes back in the chat's status as
`created`, and the page shows a card offering to move the chat there, which
opens the same dialog. A move is broadcast as `chat_moved`, so other pages
with the chat open follow it to its new workspace. Files the chat already
made stay where they are, and a chat open in a terminal or desktop app at
the same time keeps writing where it was.

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

## Just ask

**Just ask** in the sidebar starts a chat with no workspace picked. The
first message is sent to `POST /api/route`, which asks a cheap model which
project it is about and answers `{ dir, name, confidence, reason, model }`.
The page then switches to that workspace, opens a new chat there and sends
the message through the usual `/api/send`, with the agent, model, effort,
mode and extra folders the composer shows. A line at the top of the chat
says which project was picked and why.

The routing call is a Claude Code run through the Agent SDK with no tools,
one turn, a JSON output schema and no saved session, so it never appears in
the sidebar or in `claude --resume`. It needs the host's Claude Code login,
whichever agent will do the work. `ROUTE_MODEL` picks the model, `sonnet`
by default (the alias for the current Sonnet). The system prompt is the
[workspace index](#workspace-index), so the model sees each project's path,
README paragraph and recent chat titles, and the message itself. A call
takes a few seconds and costs about 2,500 input tokens, most of it the index.

The answer has to be a top-level project under `PROJECT_ROOTS`; a path
inside one counts for that project, and anything else counts as no match.
When the answer is no match (a general question, or a task that asks for a
new project), the page says so and keeps the task in the composer. When the
confidence is `low`, it asks before sending. Picking a workspace, opening a
chat or pressing **New conversation** leaves the Just ask state. A message
with only images can't be routed; add words.

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

## Files

A file dropped or picked in the composer that isn't an image (or any file,
for an agent that can't take images) is uploaded to
`~/.agentdeck/uploads/<random>/<name>` on the host, and that path is inserted
at the cursor. Characters other than letters, digits and `._@+-` in the name
become `_`, so the path never needs quoting. Each file can be up to 500 MB.
Folders can't be dropped. Uploads are kept until you delete them.

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

## Stats

**Stats** in the sidebar footer opens a page of usage charts, built by
`lib/stats.mjs` from what the agents already keep on disk — nothing new is
recorded, and chats from terminals and desktop apps count too:

- Claude Code: the transcripts in `~/.claude/projects/*/*.jsonl` (or
  `$CLAUDE_CONFIG_DIR/projects`). Prompts are user entries that aren't tool
  results, meta lines or subagent internals; replies, models and tokens come
  from assistant entries, deduplicated by API message id because a transcript
  writes one line per content block. Error placeholders (`<synthetic>`) are
  skipped. Chats in the Claude desktop app's temporary scratch folders are
  left out, as they are in the sidebar.
- Codex: the rollout files in `~/.codex/sessions` (or
  `$CODEX_HOME/sessions`). The model comes from each turn's `turn_context`;
  prompts skip the context blocks Codex injects (they start with a tag);
  tokens come from `token_count` events, with cached input subtracted.
- opencode: `~/.local/share/opencode/opencode.db`, read directly with
  `node:sqlite` (Node 22+; on older Node, opencode is simply missing from the
  page). Subagent sessions are left out.

`GET /api/stats` answers `{ rows, sessions, at }`: rows are hour buckets
(`t, agent, dir, model, prompts, replies, tin, tout`; `tin` is fresh input
tokens, `tout` output tokens) and sessions are one `{ t, agent, dir }` per
conversation. All slicing — the range and agent filters, days, weekday×hour,
models, projects — happens in the page (`public/stats.js`), so filters never
refetch. Tokens are what each agent records, so they're a floor, not a bill:
Claude subagent turns and cache reads aren't included.

The transcript folders hold gigabytes, so files are scanned line by line with
cheap string checks rather than JSON-parsing every line, and each file's
buckets are cached by mtime and size in `~/.agentdeck/stats-cache.json`. The
first scan reads everything (a few seconds per gigabyte); after that only new
or appended files are read, and **Refresh** rescans while keeping the old
render on screen. Deleting the cache file just makes the next scan a full
one.

Times are bucketed by hour in UTC and rendered in the browser's time zone, so
the time-of-day heatmap is local to whoever is looking. The agent colors are
fixed (Claude Code purple, Codex orange, opencode green) and don't shift when
filters hide a series; every chart's numbers are also in its "View as table"
fold.

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

### Running a code block

A reply's fenced code block tagged `bash`, `sh`, `zsh`, `shell`, `console`,
`shellsession` or `terminal` gets a **Run** button once the reply has
finished streaming. If any line starts with `$ `, those lines (without the
`$ `) are the command and the rest is output; otherwise the whole block is.
The page asks with `confirm` (the command and the folder) and then sends
`POST /api/run { command, dir }`, where `dir` is the open chat's folder. The
server runs it exactly as a quick action's command (`runCommand`: same
shell, environment, 60 s limit and 100 KB of output) and answers
`{ code, output, timedOut, ms }`, shown in a card above the composer on that
device; running the same command again replaces its card. Commands over
10,000 characters and folders that don't exist are refused with `400`.

### Tool Hub

[Tool Hub](https://github.com/yuanyang7/tool-hub) is a local control panel
that starts and stops the dev server of each project under `~/code`. When it
runs, the header shows a project bar for the open workspace's tool; without
it nothing shows, and agentdeck never waits for it.

Discovery: the server asks `GET /api/tools` at `TOOL_HUB_URL` (default
`http://127.0.0.1:8765`; `off` disables the whole feature) and keeps the
answer for 30 seconds; a failed probe, with a 3-second timeout, counts as
"no hub" for the same 30 seconds and is tried again on the next request
after that. One probe runs at startup, without blocking it, and prints
whether a hub answered. The open workspace maps to the tool whose `dir`
in the hub's payload is the same folder (both paths are resolved through
symlinks, and only an exact match counts, so a chat in a subfolder of a
tool shows no bar).

Routes, behind the usual device and same-site checks:

- `GET /api/hub?dir=…` answers `{ hub: null }` when no hub answers
  (`{ hub: null, disabled: true }` with `TOOL_HUB_URL=off`, which stops the
  page asking again), or `{ hub: { url }, tool }`, where `tool` is
  `{ id, name, emoji, running, port, url, self }` or `null` for a folder the
  hub doesn't know. `running` is the hub's word: started by the hub, or
  found listening from the tool's folder. `self` marks agentdeck's own
  folder, whose Restart is the built-in one.
- `POST /api/hub/restart { dir }` calls the hub's `POST /api/restart/<id>`
  and answers `{ message }` with the hub's text; a hub that answers 404 to
  that gets `stop` and then `start` instead, and the two messages joined.
  Hub errors come back as `502`.

The hub relays each running tool's port on this machine's Tailscale IP, so
the tool and hub links are built with the host name the page used for
agentdeck: `http://<same host>:<tool port>/` and
`http://<same host>:<hub port>/#tool=<id>`. A `TOOL_HUB_URL` pointing at
another machine uses that machine's name instead. The page asks for the
status when the workspace changes and every 30 seconds while it is visible.

### feedback-loop

[feedback-loop](https://github.com/yuanyang7/feedback-loop) turns bug
reports into GitHub issues that an agent reproduces and fixes, stopping at a
pull request. When the open workspace is enrolled in it, the project bar
also shows the target's bug queue and a **Report** button, with or without
Tool Hub. Elsewhere nothing shows, and so it does when the CLI isn't
installed.

A folder is enrolled when it, or a folder above it in the same git
repository, has `.feedback-loop/config.yml`: a chat in
`mini-games-hub/games/<game>` reports to `mini-games-hub`, while a nested
repository with its own `.git` doesn't take its parent's. Everything goes
through the CLI, run on agentdeck's own `node` with `/opt/homebrew/bin` and
`/usr/local/bin` added to `PATH` (it calls `gh`):

- `GET /api/feedback?dir=…` answers `{ feedback: null }` for a folder that
  isn't enrolled (`{ feedback: null, disabled: true }` with
  `FEEDBACK_LOOP=off`), or `{ feedback: { target, repo, sub, counts,
  dashboard } }`. `counts` is `feedback-loop status <dir> --json`'s, or
  `null` when that failed; the answer is kept 60 seconds per enrolled
  folder and then refreshed in the background, so only the first ask
  waits for it (about a second or two). `sub` is the chat's folder inside
  the enrolled one, `''` at its top.
- `POST /api/feedback/report { dir, title, body, severity, ready }` runs
  `feedback-loop report <dir> --title … --body-file … --severity …
  --source agentdeck --json` and answers its `{ number, url, target }`.
  `severity` is `low`, `medium` (default) or `high`; `ready: true` adds
  `--ready`, which applies `agent-ready`, the label that lets the loop pick
  the issue up without being asked. A report from a subfolder gets a
  `Folder:` line at the end of its body. CLI errors come back as `502`.

The bar's queue shows its most pressing number: what needs you
(`needsYou` + `needsInfo`, in amber), else what's being fixed, else open
PRs, else what's queued (`agentReady` + `reproduced`); the tooltip lists
them all. It links to the target's page on the feedback dashboard: the
config's `dashboard.url` when set, else `feedback-loop dashboard --all` on
port 7777, its default. A `localhost` name in either becomes the host name
the page used, since the dashboard, like agentdeck, listens on the
Tailscale address. **Report** opens a form (title, details, severity, "let
the agent fix it") and shows the new issue in a card with a link to it.

When the header is too narrow for the whole bar (the chat title would get
less than 160 px), the bar folds into a button with the project's name and
its buttons drop down under it, as on phones. A folder only feedback-loop
knows shows a 🐞 there instead of the server dot, amber when something
needs you.

## Links into agentdeck

The page keeps where you are in its address: `#dir=<folder>` opens that
project, and `&a=<agent>&s=<session id>` opens one of its chats. Another
local tool can hand a task over with `#dir=<folder>&prompt=<text>`: that
opens a new chat in the folder with the text already in the composer, where
you pick the agent, model and mode and send it yourself. Nothing is sent on
its own, and the prompt leaves the address once the page has read it.

## Code layout

- `server.mjs`: HTTP routes, device approval checks, projects.
- `lib/devices.mjs`: approved devices and the requests waiting for approval.
- `approve.mjs`: `npm run approve`, approving a device from the host's terminal.
- `lib/hub.mjs`: live conversations, the one-turn lock, permission prompts
  and the event stream every browser listens to. It doesn't depend on the
  agent.
- `lib/items.mjs`: the agent-neutral transcript format the page renders.
- `lib/workspace-index.mjs`: the project map given to agents.
- `lib/router.mjs`: Just ask, picking the project a task is about.
- `lib/folders.mjs`: a chat's extra folders: checking them and spotting
  projects a message names.
- `lib/commands.mjs`: reading a `/name` message and caching each folder's
  list of skills.
- `lib/actions.mjs`: the quick-action buttons; the restart itself is in
  `server.mjs`.
- `lib/toolhub.mjs`: finding Tool Hub and the open workspace's tool in it,
  for the project bar.
- `lib/feedbackloop.mjs`: whether the open workspace is in feedback-loop,
  its bug queue, and filing reports through the CLI.
- `lib/stats.mjs`: the Stats page's data, scanned from the agents' own files
  into hour buckets and cached per file; `public/stats.js` renders it.
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
