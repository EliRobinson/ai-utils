# Changelog

Entries start at 1.1.1. Earlier changes are in the git history of `plugins/asks-board`.

## 1.1.1

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
  - A note sent while its card is still saving stays in the box, and the card says to send it again in a moment. Before, it was lost.
- `scripts/check-board-page.mjs` checks all of the above.
