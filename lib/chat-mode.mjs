// Chat: a conversation about nothing in particular, as in the Claude app's
// chat tab, rather than about a project. Chats live in one folder of their
// own (CHAT_DIR), which the sidebar shows as the **Chat** workspace, so every
// agent lists, continues, tags and forks them like any other conversation.
// There, every agent offers a *Chat* mode: a general assistant that answers
// in the chat, can search the web and read files dropped into the message,
// and doesn't edit or run anything. Each backend maps it onto what it has:
// Claude Code gets this prompt instead of its coding one and only the web and
// read tools; Codex, opencode and Gemini get it as instructions on top of
// their read-only modes (see each file in lib/agents/). The workspace index
// is left out of chats, since they aren't about the projects.

import os from 'node:os';
import path from 'node:path';

export const CHAT_MODE = 'chat';
export const CHAT_MODE_LABEL = 'Chat';

const AGENTDECK = path.join(os.homedir(), '.agentdeck');
export const CHAT_DIR = process.env.CHAT_DIR || path.join(AGENTDECK, 'chat');
// Files dropped into a message are copied here (see /api/upload in
// server.mjs); a chat may read them without asking.
export const UPLOADS_DIR = path.join(AGENTDECK, 'uploads');

export const isChatMode = (mode) => mode === CHAT_MODE;

const today = () => new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

// The instructions for a chat. `agent` is the agent's label; `full` makes it
// a whole system prompt (Claude Code, whose coding prompt is replaced) rather
// than instructions added to the agent's own.
export function chatPrompt(agent, { full = false } = {}) {
  const lines = [];
  if (full) lines.push(`You are ${agent}, used as a general assistant in agentdeck, a web page the user chats with from their devices. Today is ${today()}.`);
  else lines.push(`This conversation is a chat, not work on a project. ${agent} is used here as a general assistant.`);
  lines.push(
    '',
    'Answer the question in the chat, in markdown. Be direct and concise; match the length of the answer to the question. Search the web when the answer needs facts you may not have or that may have changed, and say what you found where.',
    '',
    `The folder you are in (${CHAT_DIR}) is scratch space, not a codebase. Files the user drops into a message are copied to ${UPLOADS_DIR} and their paths put in the message: read them when asked about them. Do not edit files or run commands here; if the user asks for changes to a project, say that a conversation in that project's workspace in agentdeck can make them.`,
  );
  return lines.join('\n');
}
