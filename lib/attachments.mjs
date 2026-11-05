// Files an agent hands the user. A reply attaches a file on the host with a
// fenced code block whose language is `attach`, one path per line; the page
// shows each as a card that downloads it through /api/file?download=1, so it
// reaches whichever device the user is on. Every agent is told how in its
// instructions: the chat prompt (lib/chat-mode.mjs) in chats, and next to the
// workspace index in projects (server.mjs).

export const ATTACH_NOTE =
  "Sending files: the user may be on a phone or another computer, so a path on this machine isn't something they can open. To give them a file (a report, an export, a generated document or image, an archive), end the reply with a fenced code block whose language is `attach`, one path per line (absolute, or relative to this chat's folder); agentdeck shows each as a card that downloads the file to their device. A markdown link to a file on this machine downloads it too. Only attach files that exist and that the user asked for or will want; to send a folder, make an archive of it first.";
