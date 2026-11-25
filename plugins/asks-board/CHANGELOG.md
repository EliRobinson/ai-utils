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
  - A second click on the answer already chosen (the same status and the same answer) saves and pings nothing. The card says "No change, so nothing was sent."
  - The ping waits for the comment anchor at most 2 seconds, so a click always ends.
- `scripts/check-board-page.mjs` checks all of the above.
