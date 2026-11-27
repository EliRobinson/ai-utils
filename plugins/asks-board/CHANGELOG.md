# Changelog

Entries start at 1.3.0. Earlier changes are in the git history of `plugins/asks-board`; 1.2.0 (chat-only asks) is described under agent-roster 1.14.0 in `plugins/agent-roster/CHANGELOG.md`.

## 1.4.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update asks-board@ai-utils`, then restart Claude Code.
2. Republish `board-template.html` as the `asks-board` skill's "Changing this skill or the board page" section says. Until you do, the board you have shows no chat count.
3. Restart or resume each project coordinator and the Board Router so they load the new skill. Coordinators then write `chatWaiting` on their next chat-only question or check-in; until each does, its project shows no count.

**Changes:**

- **"N waiting on you in your chats" in the board header** (#38). Chat-only asks (a merge, a ticket, a new PR) are not board rows, so the board did not show that a chat was waiting on you. Now the header shows how many are waiting, with each project's count and when it was updated.
  - The count lives on the project's `routes` row as `chatWaiting: {count, updatedAt}`. Only that project's coordinator writes it: when it asks a chat-only question, when your typed answer arrives, and at each check-in.
  - It is read-only: no buttons, and the page never writes `routes`. It is plain text, not a live region, so it is never announced.
  - Only counts above 0 show. A bad count (missing, not a number, negative, not whole) is ignored. A count older than 24 hours, with no readable time, or dated more than 5 minutes ahead is muted and says "may be out of date"; the headline then says how many may be out of date. A coordinator that stops checking in leaves a stale line, not no line.
  - While a chat waits on you, the summary says "Nothing to click here." instead of "You’re all caught up." when the board has nothing for you.
  - The Board Router ignores `chatWaiting`: it never pings, routes or reacts to it.
- `scripts/check-board-page.mjs` tests the new display, checks that the page only reads `routes`, and checks that the router rules say to ignore `chatWaiting`.

## 1.3.1

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update asks-board@ai-utils`, then restart Claude Code.
2. Republish `board-template.html` as the `asks-board` skill's "Changing this skill or the board page" section says. Until you do, the board you have keeps the old subtitle.

**Changes:**

- **Board subtitle says what the board holds** (#39). It now reads "Asks a click can settle." and tells you that asks needing a typed answer, like a merge, a ticket or a new PR, come up in your chats. Before, it said the board held everything your chats need from you. The two empty-state messages say the same. No layout or styling changed.

## 1.3.0

**Upgrade steps:**

1. `claude plugin marketplace update ai-utils`, then `claude plugin update asks-board@ai-utils`, then restart Claude Code.
2. Republish `board-template.html` as the `asks-board` skill's "Changing this skill or the board page" section says. Until you do, the board you have keeps the old behaviour.

**Changes:**

- **One click sends one ping** (#32). A fast double click, or a click while the last one was still saving, could save the row twice and ping the chat twice.
  - The card stays busy until both the save and the ping have ended, failed or not. Before, it was free again once the comment anchor settled, which could be before the ping was sent.
  - While a card saves, its tick, option buttons and Not needed are disabled, and the card has `aria-busy="true"`. If one of them had focus, focus goes back to it when the save ends.
  - A click that sets what the row already has (a second click on the chosen answer, or Done on a done card) saves and pings nothing. The card says "Already set, so nothing was saved or sent. To tell the chat more, add a note."
  - Once a save ends, the page reads the row as saved even before the live update arrives, so a quick repeat click still changes nothing.
  - A click waits at most 2 seconds for the comment anchor, and at most 15 seconds for the save and for the ping, so a card never stays locked.
  - While a card saves, its note's Send note button waits too. A note sent anyway stays in the box, and the card says to send it again in a moment. Before, it was lost.
- `scripts/check-board-page.mjs` tests the same-answer check, the busy hold and the time limits, and checks that the page source keeps the disabled controls, `aria-busy` and the note guard.
