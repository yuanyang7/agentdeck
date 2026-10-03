# Backlog

## Completed

### 2026-10-02 — Per-chat model and effort

- Final behavior: Each chat's model and effort are stored on the server (`~/.agentdeck/models.json`), recorded whenever a turn starts and whenever the pickers change in an open chat. Opening a chat on any device shows its stored model; other devices viewing the chat follow changes live. Every switch adds a notice line to the transcript ("Switched to …" locally, "Now using … (changed on another device)" remotely). The per-browser choice now only seeds new chats.
- Verification: `node --check` on changed files; endpoint, broadcast and storage smoke-tested against a temporary HOME.
- Remaining limitations: Chats last used before this change have no record and show the agent's default until their next message. Switch notices are live only and are not kept in the transcript history.

### 2026-10-02 — Responsive interface redesign

- Final behavior: Agentdeck has a refreshed workspace sidebar, conversation view, empty state, login, and composer. On narrow screens, conversations open in a dismissible drawer; composer options scroll horizontally while attachment and send actions stay visible. Keyboard users can open sessions and return focus from the drawer.
- Verification: `node --check public/app.js`, `git diff --check`, local server response, desktop browser preview, and adversarial diff review.
- Remaining limitations: Mobile layout was reviewed from the responsive CSS and interaction code; a device viewport screenshot was not captured in this environment.
