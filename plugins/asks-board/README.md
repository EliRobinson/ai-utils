# asks-board

One page for everything your Claude chats need from you.

- Each chat adds an "ask" (do, decide or approve) to a claude.ai artifact board. The board shows every project at once, grouped, with a filter per project and per kind.
- You tick it, press an option, press "Not needed" or leave a note. The result shows right next to the card you clicked.
- The page sends a comment to Claude. One chat, the **Board Router**, watches the board and forwards the ping to the chat that asked, by session id. That wakes the chat even if it is closed.
- The chat acts, closes the row and replies in the thread. A row shows as Closed only when its status is `closed`. Each click clears the chat's old `ackAt`, so a new answer is never hidden.
- Only asks a board click can resolve go on the board. Any ask a board click cannot resolve goes in the coordinator chat as a direct question, and not on the board, because you must answer it in chat anyway: a merge request ("merge N"), filing or editing a ticket, opening a PR, allowing a third review round, and anything else whose answer must be typed in chat. A board row for it only duplicates the question. The test: can a board click alone unblock this? If no, ask in chat only.

To get a fixed board page after a change merges, republish `board-template.html` as the `asks-board` skill's "Changing this skill or the board page" section says. Rows an older page left with an `ackAt` but not `closed` then show under "Waiting for the chat"; the owning chat's next check-in closes them (see "A row needs you" in the `asks-board` skill). Rows of a chat that no longer checks in stay there for now.

## What is here

```
skills/asks-board/            daily rules: add asks, check in, coordinator and router rules
skills/asks-board-setup/      setup steps + board-template.html (the board page)
                              + scripts/check-board-page.mjs (tests the page's section, click, ping, option, filter and receipt logic)
```

Personal values never go in this repo. Each user keeps them in `~/.claude/asks-board.md`:

```
Board: https://claude.ai/artifact/<id>
Owner: <first name>
```

Project-to-chat routes live in the board's own `routes` collection.

## Set it up

```
/plugin marketplace add EliRobinson/ai-utils
```

```
/plugin install asks-board@ai-utils
```

Then ask Claude: "Set up my Asks board". The `asks-board-setup` skill publishes the page, writes the config file, seeds the routes and tests a ping.

To edit the skill from a local clone of this repo instead, symlink it (do not also install the plugin):

```bash
ln -s <clone>/plugins/asks-board/skills/asks-board ~/.claude/skills/asks-board
```

## Change it

The source lives here, in the public `ai-utils` repo (EliRobinson/ai-utils). Every change goes through a feature branch and a PR, never a push to `main`, and the new board page is published only after the PR merges. The steps are in the `asks-board` skill's "Changing this skill or the board page" section; outside contributors also see Contributing in the root README.

## Limits

- Pings reach only chats on the same computer.
- If the router chat is closed, pings stop. Answers stay on the board, and the router forwards them when it opens.
- Only one chat may watch the board.
