# Backlog

## Completed

### 2026-10-04 — Agentdeck icon

- Final behavior: A generated conversation-card icon appears in the README, sidebar, sign-in screen, and new-conversation empty state. The browser tab uses a 64 px PNG favicon, and saved home-screen shortcuts use a 180 px touch icon. All versions are served from the project.
- Verification: Inspected the generated icon and its 64 px version; confirmed the PNG dimensions; `node --check` for the server and app script; `git diff --check`; local HTTP GETs returned 200 with `image/png` for all three assets. An adversarial review flagged edge artifacts in an earlier transparent draft, which were resolved by generating the final opaque icon.
- Remaining limitations: No browser screenshot was captured because the available browser automation had no browser connection.

### 2026-10-03 — Images shared by agents

- Final behavior: Tool items carry an `images` list, shown as thumbnails below the tool card (visible while it is collapsed). Sources: image blocks in Claude tool results (Read, MCP screenshot tools), Codex `imageView`, `imageGeneration`, MCP and dynamic tool images, and opencode tool file attachments. Markdown images in replies that reference host files (absolute path, `file://`, or project-relative) are rewritten to `/api/file`, which serves image-extension files only, with `nosniff` and a sandboxing CSP for SVG. Clicking an image opens it full size, including data URLs (opened through a blob URL); images that fail to load show "Image not available".
- Verification: `node --check` on all changed files, `git diff --check`, `/api/file` probes (image 200, missing 404, non-image and relative paths 400), Claude history for a session with 42 image tool results, markdown rewrite cases in headless Chrome, and a headless Chrome screenshot of that session.
- Mentioned images: image file names in a finished reply (plain text or inline code, outside code blocks and links) get thumbnails under their paragraph or list item. Absolute and `~/` paths are used as-is; bare names match image paths seen in earlier tool calls; paths with a folder resolve against the project. Missing files are dropped silently; at most 24 per reply; skipped while a reply is streaming. Verified on a Claude chat whose summary named 8 screenshots by bare file name (all 8 shown, headless Chrome screenshot).
- Remaining limitations: Codex and opencode image paths were written against their protocol schemas (Codex app-server 0.133, opencode's `ToolContent`) and not exercised in a live turn. Any image file on the host can be fetched by path by anyone who can reach the page.

### 2026-10-02 — Approval request navigation

- Final behavior: An open chat with pending permission or question requests shows a Review control in the header with a count. It moves keyboard focus to the first request. The control disappears when all requests resolve. Screen readers receive announcements when requests arrive or resolve, including partial resolution. Existing request cards stay mounted across unrelated status events so question selections and focus are preserved.
- Verification: `node --check public/app.js`, `git diff --check`, local HTTP smoke test for the page and assets, and adversarial diff review.
- Remaining limitations: The header control reflects pending requests in the open chat; it does not aggregate requests from other conversations.

### 2026-10-03 — Per-chat model, effort and permission mode

- Final behavior: Each chat's model, effort and permission mode are stored on the server (`~/.agentdeck/chat-settings.json`, migrated from the earlier `models.json`), recorded whenever a turn starts, its mode changes, or the pickers change in an open chat. Opening a chat on any device shows its stored settings; other devices viewing the chat follow changes live. Every switch adds a notice line to the transcript ("Switched to …" locally, "Now using … (changed on another device)" remotely). Chats without a record get what the agent says they last used, recorded once: Claude from the transcript file (model of the last reply, mode of the last prompt), Codex from the last `turn_context` in the rollout file (model, effort, approval and sandbox policy), opencode from the session (model, variant, agent and permission rules). The per-browser choice (now including the mode) only seeds new chats.
- Verification: `node --check` on changed files; inference checked on real Claude, Codex and opencode chats; endpoint, validation, broadcast and migration smoke-tested against a temporary HOME; headless Chrome check that an existing chat opens with its own mode and model, and that a mode switch shows a notice and survives a reload.
- Remaining limitations: Claude transcripts don't record effort, so inferred Claude chats show the default effort until changed. Codex inference depends on its rollout file format and falls back to defaults if that changes. A record is not refreshed if the chat is later continued outside agentdeck with other settings. Switch notices are live only and are not kept in the transcript history.

### 2026-10-02 — Responsive interface redesign

- Final behavior: Agentdeck has a refreshed workspace sidebar, conversation view, empty state, login, and composer. On narrow screens, conversations open in a dismissible drawer; composer options scroll horizontally while attachment and send actions stay visible. Keyboard users can open sessions and return focus from the drawer.
- Verification: `node --check public/app.js`, `git diff --check`, local server response, desktop browser preview, and adversarial diff review.
- Remaining limitations: Mobile layout was reviewed from the responsive CSS and interaction code; a device viewport screenshot was not captured in this environment.
