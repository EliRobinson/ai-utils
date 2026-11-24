---
name: asks-board-setup
description: Use when the user wants to set up an "Asks" board (one claude.ai artifact that lists everything their Claude chats need from them, with instant pings back to the asking chat through one Board Router chat), or to move an existing board to a new computer.
---

# Set up an Asks board

The board is one Artifact page. Each Claude chat adds what it needs from the user (an "ask") as a row. When the user ticks, picks an option, says "Not needed" or leaves a note, the page sends a comment to Claude. One chat, the **Board Router**, watches the board and forwards each ping to the chat that asked. The daily rules live in the `asks-board` skill.

To set up a repo's whole agent workflow (worktrees, branch names, the review gate, the coordinator prompt), use the `setup-agentic-workflow` skill from `agent-roster`. It runs this skill when the board is missing, and passes in the owner's name, the project slug and the chat name. Do not ask for values you were given. When it calls you, skip the plugin install in Step 3, skip the `SendMessage` to project chats in Step 4, and leave the Step 5 test for the coordinator, which runs it when it starts.

Do every step below, in order. Ask the user for anything marked ASK.

## Step 1. Collect the values

- ASK: their first name (shown as "Asks for <name>").
- ASK: do they already have a board link? If yes, you are moving it to this computer: skip to Step 3 after writing the config file.
- ASK: their project chats, as `project-slug = exact chat name` (for example `web-app = Web App Coordinator`).

## Step 2. Publish the board page

1. Load the `artifact-capabilities` skill. Load `ArtifactData`, `ArtifactComments` and `SendMessage` with ToolSearch.
2. Copy `board-template.html` (next to this file) to your scratchpad as `index.html`. Replace every `{{OWNER}}` with the user's name.
3. Publish it with the `Artifact` tool: `file_path` = that copy, `capabilities: {"assets": {}, "db": {}, "comments": {}}`, `contract: "latest"` (sending comments to Claude needs a recent runtime), `icon: "checklist"`.
4. Seed the `routes` collection with `ArtifactData` `batch`: one `set` per project, `doc_id` = slug, data `{project, session: "<exact chat name>", sessionId: "<local_... id>", note: "", updatedAt: "<now>"}`. Get each `sessionId` from `mcp__ccd_session_mgmt__list_sessions` by exact title. Leave it out if the chat is not on this computer.

What the page does (keep this when you change it):
- Collection `asks` with fields project, from, kind (do | decide | approve), title, detail, options [{key,label}], recommended, images [{id, caption}], status (open | done | answered | dismissed | closed), answer, note, noteImages [{id}], noteAt, noteAckAt, ackAt, threadId, createdAt, updatedAt.
- Project tabs, three sections: To do (status open), Done waiting for the chat (status done/answered/dismissed), Closed (status closed only). `ackAt` never moves a row between sections.
- Every click writes `ackAt: null` with its change, so the chat sees the click as new. It never touches `noteAckAt`. `sections()` and `stamp()` hold this logic; `scripts/check-board-page.mjs` tests them.
- Each card: done checkbox, option buttons (recommended one marked), "Not needed", "Add a note" with image paste or upload, "Show details".
- The ping: on each click it starts `comments.anchorFor(card)` inside the click (it needs the user's gesture), saves the row, then calls `comments.sendToClaude` into the row's `threadId` (or a new thread, saving the id). The text is three lines: `[asks-board] project=<p> | from=<chat> | ask=<id>`, what the user did, and a line telling the platform's automatic reply and the comments chat to reply only "Received.". The router and coordinators never reply to that line; a coordinator gets only the router's message. A failed ping never blocks the save.

## Step 3. Write the config file and the skill

1. Write `~/.claude/asks-board.md`:
   ```
   Board: <board link>
   Owner: <name>
   ```
2. Install the `asks-board` skill. Either:
   - install the plugin: `/plugin marketplace add EliRobinson/ai-utils`, then `/plugin install asks-board@ai-utils`; or
   - if this computer has a clone of `ai-utils` and the user will edit the skill: `ln -s <clone>/plugins/asks-board/skills/asks-board ~/.claude/skills/asks-board`.
   Use one, not both, or the skill loads twice.

## Step 4. Pick and start the router

- This chat published the page, so its watch armed by itself. Ask the user which chat is the Board Router. Recommend a small chat that does only this.
- If the router is a different chat: tell the user to paste the board link into that chat themselves (auto-replies only arm when the user pastes the link there). Send it the router rules by `SendMessage` and wait until it confirms "auto-replies armed" (`ArtifactComments` `watch` with no url lists the board with that text). Then stop this chat's watch: `action: "watch"`, `on: false`, `url` = the board.
- `SendMessage` every project chat: "Use the asks-board skill. Do not watch the board. Pings come from the Board Router."

## Step 5. Test

- Add a test ask in one project: kind `decide`, options A and B, title "Test: press any option to check the instant ping".
- Tell the user to reload the page and press A. Check that the router replied "Sent to <chat>", and that the project chat got the message and closed the row.
- Report what worked and what did not, in short plain sentences.

## Limits to tell the user

- `SendMessage` only reaches chats on the same computer. A chat on another computer gets nothing until it reads the board.
- A chat in a different permission mode may hold the router's message until the user approves it.
- If the router chat is closed, pings stop. Nothing is lost: answers stay on the board, and the router's startup sweep forwards them when it opens.
- Pings only go out when the user can edit the board (owner or editor).
