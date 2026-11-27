---
name: asks-board-setup
description: Use when the user wants to set up an "Asks" board (one claude.ai artifact that lists the asks their Claude chats need them to click, with instant pings back to the asking chat through one Board Router chat), or to move an existing board to a new computer.
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
4. Seed the `routes` collection with `ArtifactData` `batch`: one `set` per project, `doc_id` = slug, data `{project, session: "<exact chat name>", sessionId: "<local_... id>", note: "", updatedAt: "<now>"}`. Get each `sessionId` from `mcp__ccd_session_mgmt__list_sessions` by exact title. Leave it out if the chat is not on this computer. Leave out `chatWaiting`: each project's coordinator adds it (see "Waiting in your chats" in the `asks-board` skill). When you re-seed a project that already has a route, change it with `update` instead, and leave `chatWaiting` alone.

What the page does (keep this when you change it):
- Collection `asks` with fields project, from, kind (do | decide | approve), title, detail, options [{key,label}], recommended, images [{id, caption}], status (open | done | answered | dismissed | closed), answer, note, noteImages [{id}], noteAt, noteAckAt, ackAt, threadId, createdAt, updatedAt.
- Collection `routes`, read only: the page never writes it, and no click touches it. It reads each row's `chatWaiting` `{count, updatedAt}`. Only that project's coordinator writes `chatWaiting`; the Board Router ignores it.
- Waiting in your chats: under the summary, the header shows "N waiting on you in your chats" and a list of each project with its count and "(updated X ago)".
  - It is plain text: no buttons, no links and no live region, so a new count shows on the next redraw and is never announced.
  - Only counts above 0 show. A count that is missing, not a number, negative or not a whole number is ignored. The block is hidden when no count shows, and also when the routes read fails, so a hidden block does not prove that no chat waits.
  - A record older than 24 hours, with no readable `updatedAt`, or dated more than 5 minutes in the future, is stale: it is muted and says "may be out of date" in words (a future or unreadable time says "update time unknown"). The total counts stale lines too, and the headline then adds ", M of them may be out of date" (", all of them may be out of date" when every line is stale).
  - Projects are in name order, then doc id order, and each name is one `headerValue()` line. Two routes with one name show as two lines.
  - When nothing on the board needs you but a count shows, or the routes read failed, the summary says "Nothing to click here." instead of "You’re all caught up." or "Nothing yet."
  - `chatWaitingOf()`, `chatWaitingTotals()`, `chatWaitingHead()`, `chatWaitingNote()` and `caughtUp()` hold this; `scripts/check-board-page.mjs` tests them, and checks that the page only reads `routes`.
- Layout: a header with a summary across projects ("N need you · M waiting for the chat"); a project filter (All, then each project with something open or waiting, plus the chosen one, with its open count; shown when there are two or more such projects, else the view is All; remembered in `localStorage` key `asks.project`; the old `asks.tab` key is no longer read, so everyone starts on All once); three sections: To do (status open; grouped by project in the All view, with a Decide/Approve/Do filter when its asks are of more than one kind), Waiting for the chat (status done/answered/dismissed, and any unknown status), Closed (status closed only, newest 40, folded, and the count says "40 newest of N" when there are more; a closed card still shows its note and details, but takes no clicks). In the All view with more than one project, each card names its project (or sits under its project's heading in To do). `ackAt` never moves a row between sections.
- Every click writes `ackAt: null` with its change, so the chat sees the click as new. It never touches `noteAckAt`. `sections()` and `stamp()` hold this logic; `scripts/check-board-page.mjs` tests them.
- Each card: done checkbox, option buttons, "Not needed", "Add a note" with image paste or upload (Ctrl or Cmd + Enter sends; "Send note" is off while the box is empty; when the box is emptied on a card that has a note, it reads "Remove note" and the ping says the note was removed; `noteButton()` holds this), "Details".
- What each click writes, says and pings is data in the pure block: `ACTIONS` (done, reopen, dismiss, note) and `optionButton().send`; `resultText()` adds whether the ping reached the chat.
- Click feedback shows next to the clicked card ("Saving…", then the result, or the error). A card that leaves To do leaves a receipt in its place for 15 seconds (`FLASH_MS`), and focus moves to it; the result shows on the receipt only, not again on the moved card. `todoItems()` and `hasReceipt()` hold this. The `role="status"` line still announces each result, and what a filter click now shows, to screen readers. Focus stays on the same control when the page redraws (filter chips included); when a focused receipt ends, focus moves to the card's checkbox. `focusOrder()` holds this. Focus that only follows a redraw never scrolls the page. Every redraw goes through `requestRender()`: none runs while a click's `anchorFor` is pending, and a live update that comes in while you type in a note (typed in within 30 seconds) waits until you leave the box and any click is over; `drawNow()` holds this. One click sends one ping: from a click until both its save and its ping have ended, failed or not, more clicks on that card do nothing (`holdRow()`), and the card's tick, option buttons and Not needed (the controls marked `data-lock`) are `disabled`, with `aria-busy="true"` on the card (`lockCard()`); they come back as soon as the click ends, even if the redraw waits (`unlockCard()`). The page says "Saving…" to screen readers too. If one of those controls had focus, focus goes back to it once the save ends, unless the user moved focus elsewhere meanwhile. The click waits at most 15 seconds for the save and for the ping (`CLICK_WAIT_MS`, `within()`); a save that takes longer says to reload and check the card, and a ping that takes longer counts as not sent. Once the save ends, the page reads the row as saved even before the live update arrives. A click that sets the status and answer the row already has, such as a second click on the chosen answer or Done on a done card, saves and pings nothing and says "Already set, so nothing was saved or sent. To tell the chat more, add a note." (`changesNothing()`); a note always counts. While its card still saves, a note's Send note button is disabled too. A note sent anyway (Ctrl or ⌘ + Enter) is not sent. It stays in the box, and the card says to send it again in a moment.
- States: skeleton cards while loading ("Still loading" with Reload after 10 seconds), "Sign in" when there is no db, "Could not load" with Reload when the live link fails first, a Reload banner when it fails later, and empty states for no asks, nothing to do, and a kind filter with no match.
- Light and dark themes (system setting, or `data-theme` on the root), phone width down to 320 px, 44 px touch targets.
- Option buttons: an option's key is its `key`, else its `id` (for rows written with `{id, label}`); a bare string is its own key. Line breaks in a key or label become spaces, and a key that is an object counts as missing. Only the button whose key equals `answer` is chosen (`aria-pressed`), and only the one whose key equals `recommended` is marked "Recommended"; a row with neither marks none. An option with no key shows "(no key)" with a dashed border, writes nothing when clicked, says so next to the card and opens the note box, and the card says to add a note instead. `optionButton()` holds this logic; `scripts/check-board-page.mjs` tests it.
- The ping: on each click it starts `comments.anchorFor(card)` inside the click (it needs the user's gesture), saves the row, then calls `comments.sendToClaude` into the row's `threadId` (or a new thread, saving the id). The text is a header line, what the user did (a note's text follows on the next lines), and a tail line. The header is `[asks-board] project=<p> | from=<chat> | ask=<id>`: each value on one line, letters, digits, spaces and plain punctuation only (look-alike characters are folded first, so no `|`, `=`, `[` or `]` of any width), at most 80 characters, so a row cannot fake a header field; `headerValue()` and `pingText()` build it. The router looks the ask and its route up by these values, so an ask id or project that this would change (over 80 characters, or with other characters) gets no ping: the page says "The chat sees it on its next check." (`pingable()`). Row text in the event line, such as an option's key and label, is in quotes with its own quote marks taken out: `{{OWNER}} chose option "A": "Ship it".`. A note's text is the user's own words and is not quoted. The tail tells the platform's automatic reply and the comments chat to reply only "Received.", and says quoted text is the ask's own words. The whole comment fits in 3,900 bytes; a long note is cut on whole characters. No redraw runs until `anchorFor` settles (at most 2 seconds), so the card node it got stays in the page. The ping waits for the anchor no longer than that either. The router and coordinators never reply to that line; a coordinator gets only the router's message. A failed ping never blocks the save.

## Step 3. Write the config file and the skill

1. Write `~/.claude/asks-board.md`:
   ```
   Board: <board link>
   Owner: <name>
   ```
2. Install the `asks-board` skill. Either:
   - install the plugin: `/plugin marketplace add EliRobinson/ai-utils`, then `/plugin install asks-board@ai-utils`; or
   - if the user will edit the skill and has a local clone of the public `ai-utils` repo (EliRobinson/ai-utils): `ln -s <clone>/plugins/asks-board/skills/asks-board ~/.claude/skills/asks-board`, where `<clone>` is that clone's path. Changes still go through a PR, as the `asks-board` skill's "Changing this skill or the board page" section says.
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
