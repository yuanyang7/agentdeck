<img src="public/agentdeck-icon.png" alt="Agentdeck icon" width="72" height="72">

# agentdeck

A small web page for driving coding-agent conversations (Claude Code, Codex
and opencode) on this machine from any other device on your Tailscale network.

Your agents, your code, and the conversation history all stay on the host
machine — other laptops or phones just open a web page. Every device sees the
same live conversation, including streaming replies and permission prompts,
so you can start something on one laptop and approve or continue it from
another.

Conversations are each agent's own native sessions — Claude Code's in
`~/.claude/projects`, Codex's in `~/.codex`, opencode's in its own store — so
anything started in a terminal or desktop app shows up here too, and anything
started here can be resumed there (`claude --resume`, the Codex app or
`codex resume`, or the session list in opencode).

![A conversation open in agentdeck, showing the sidebar with tagged conversations and a reply with tool calls and an inline image](docs/images/screenshot.png)

## Quick start

```bash
npm install
npm start
```

Requires Node 18+, and Claude Code logged in on the host — agentdeck uses
that login. Codex and opencode are optional: each one installed on the host
shows up as another agent, using its own login.

By default agentdeck listens on this machine's Tailscale IP, port 7878, so
only devices on your tailnet can reach it. On startup it prints the address
to open from other devices; prefer the MagicDNS name it prints
(`http://<machine-name>:7878`) over a bare IP, and always include the
`http://` prefix. It also answers on `http://localhost:7878` on the host
itself.

Password, port, project roots, and other settings are environment
variables — see [docs/REFERENCE.md](docs/REFERENCE.md#environment-variables).

## Security

Anyone who can open this page can run commands on the host through the
agents. Keep it on a private network like Tailscale, and set a `PASSWORD`
(see the reference doc above) if others share that network.

## Features

### Agents

The sidebar lists every agent's conversations for a project together, each
marked with its agent. When more than one agent is installed, a picker
chooses the agent for a new conversation; an existing conversation always
continues with the agent it started with. The mode, model and effort menus
adapt to show what the selected agent offers — see
[docs/REFERENCE.md](docs/REFERENCE.md#agent-modes) for what each agent's
modes mean. The **Usage** button in the header shows the plan limits of
whichever agent's login is active.

### Tags

Hover a conversation in the sidebar and click the tag button to add or
remove tags (up to 10, 30 characters each). Each change is saved as soon as
you make it. Tags you've used become **quick tags** you can toggle with one
click. The **Tags** section at the top of the
sidebar has a chip for every tag; click one to list that tag's
conversations from all workspaces. Tags live on the host and sync across every
device, but are never written into the agents' own transcripts.

### Images

Attach up to 10 images to a message — click 📎, paste, or drag files onto the
composer — and images the agent shares back (screenshots, tool output,
generated images) appear inline too, loaded from the host so every device
sees them. Click any image to view it full size. Videos the agent links or
names (MP4, MOV, WebM) play inline. See
[docs/REFERENCE.md](docs/REFERENCE.md#images) for how images and file-name
mentions are matched.

### Turns

One conversation runs one turn at a time. Messages sent while the agent is
working — from any device — wait in a queue shown above the composer and run
in order as each turn finishes. A queued message can be sent now (stopping
the current turn so it runs next), edited (taken back into the message box),
or removed before it starts. **Stop** ends the current
turn and clears the queue, putting the queued messages back into the message
box of the device that pressed it. Permission
prompts (file edits, shell commands, plan approval, questions) appear on
every connected device, and whichever answers first wins. Avoid keeping the
same conversation open here and in a terminal, desktop app, or opencode TUI
at the same time — each keeps its own copy in memory and won't see the
other's messages.

### Forks

Hover any message you sent and click the fork button beside it to branch the
conversation: the host copies it, through the end of that exchange, into a
new conversation of the same agent, which then opens. Forking from the last
message copies the whole conversation. A branch is one of the agent's own
sessions, so it resumes in a terminal too, and it starts with the model,
effort, mode and tags of the chat it came from. The fork button is hidden
while a turn is running, because the transcript is still being written.

### Workspace index

Every new conversation, with any agent, starts knowing which projects are
on this machine: each folder under the project roots with its path, the
opening paragraph of its README, when it was last active and the titles of
its latest chats from all three agents. Ask about another repo by name and the
agent knows where to look; reading outside the chat's folder still comes
up as a permission prompt. Chat titles are often the start of a chat's
first message, so whatever you typed there goes to the provider of every new
chat. Set `WORKSPACE_INDEX=off` to turn it off — see
[docs/REFERENCE.md](docs/REFERENCE.md#workspace-index).

### Sounds

A soft two-note chime plays when a conversation finishes a turn, and a more
insistent double beep when a permission prompt appears. Both play for every
conversation on the host, not just the one you have open, so a chat left
running in another workspace still calls out. The bell button in the header
mutes them, per device. Browsers only allow sound after you've interacted
with the page, so the first click or key press after opening arms it.

## More

[docs/REFERENCE.md](docs/REFERENCE.md) covers:

- All environment variables
- What each agent's permission modes mean
- How image and file-mention matching works
- Code layout, for hacking on agentdeck itself
- Running agentdeck at login (LaunchAgent), and troubleshooting

This project is MIT licensed — see [LICENSE](LICENSE).
