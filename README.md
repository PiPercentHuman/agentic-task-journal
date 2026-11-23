# Agentic Task Journal

**A task board and a journal for coding agents. Every job is a card, every milestone keeps its own journal, any new
chat continues where the last one stopped, and a finished job ends with a pull request and a report of its
requirements and what was done.**

Built for Claude Code (hooks); no dependencies beyond Node 22.5+ and git (and the GitHub CLI for pull requests).

## Why

An agent's memory of a job is its context window, and that goes away: the window fills, the chat is compacted,
cleared, closed, deleted. The next chat starts over: it re-reads the code, re-asks what was wanted, redoes the
research. And when the job is finished, nobody can say what exactly was asked, what was decided along the way, or
how the result was checked.

Agentic Task Journal keeps all of that outside the chat, written by hooks rather than by the model remembering to:

* **The journal** (AgentJournal): every message you send is pinned word for word, every action the agent takes is
  one line in a journal, and when a message changes an earlier instruction the agent writes the instruction out in
  full as it now stands.
* **The board**: every job is a card with milestones. Each milestone, when ticked, keeps the journal lines that
  produced it. A **checkpoint** per job, rewritten after every action, says where the whole job stands: milestones,
  the next step, the instructions as they stand, the last 25 actions. It lives on the board, not in the chat.
* **The end of a job**: requirements, a summary, the decisions, the files changed, the checks that were run, the pull
  request, and what is still open, as one report.

## From task to merged fix

```
board new "Invoices export as CSV" --kind feature --ref .     # a card, with the feature milestones
board req 7 "Invoices export as CSV, semicolon-separated"     # requirements, as they stand
board req 7 "The JSON export keeps working"
   ... the agent works; every action is journaled, the checkpoint follows ...
board tick 7 build                                            # a milestone, with its journal attached
board pr 7                                                    # push the branch, open the PR (body = the report)
board pr 7 --status                                           # or let sync follow it: merged ticks "merged"
board summary 7 "Added a CSV exporter beside the JSON one; the suite and a real export pass."
board done 7                                                  # prints the report, keeps every chat's journal
```

The PR body is the public part of the report: summary, requirements, decisions, work done, the branch's files, the
checks run. The user's own messages and local paths stay in the local report.

**Kinds** (the milestones a job starts with): `feature` (requirements, plan, build, test, docs, PR, review, merged,
summary), `bugfix` (report, reproduce, root cause, fix, verify, PR, review, merged, summary), `research`, `generic`.
A project adds its own in `<project>/.atj/templates/*.json`. A milestone can tick itself: `{ "exists": "path" }`,
`{ "edited": "path" }` (differs from a template copy), `{ "glob": "a/*.wav" }`, `{ "pr": "open" | "merged" }`,
`{ "summary": true }`.

## Continuing in any chat

* A **new chat** sees the board at once: this project's open jobs, one line each, then the other projects.
* `board resume <id>` prints the job's checkpoint and the chat continues from it, without re-researching. That works
  after the chat that did the work has been deleted.
* After **compaction, resume, or the `/clear` that follows an AgentJournal sleep**, the chat gets the checkpoint (and
  the journal's wake-up) by itself.

## Set up (one command)

Needs Node 22.5+ and git; the [GitHub CLI](https://cli.github.com) for the phone, sync and pull requests.

```
git clone https://github.com/PiPercentHuman/agentic-task-journal
node agentic-task-journal/bin/setup.mjs
```

It does, in order, and keeps whatever is already there when you run it again:

1. checks Node and git;
2. installs the Claude Code hooks for every project (`~/.claude/settings.json`, a copy of the old file is kept);
3. makes the board's home, `~/.agentic-task-journal` (or `ATJ_HOME`), a git repo;
4. logs you in to GitHub if needed (a code to enter on github.com), creates a **private** repo for your board
   (`taskboard`; `--board-repo <name>` for another) and syncs to it. It refuses a repo that is public;
5. turns on background sync every 15 minutes while you are logged in (`--minutes <n>`): Task Scheduler on Windows
   (no window flashes up), launchd on macOS, cron on Linux;
6. prints how to see the board on the PC, on GitHub, and on your phone, with the phone link already filled in.

`--no-github` (a local board only), `--no-schedule`, `--dry-run` (say what it would do), `--uninstall` (takes the hooks
and the timer out; the board and its repo are kept). New Claude Code sessions pick the hooks up. In a project that
already registers its own AgentJournal hook, the shared one steps aside, so nothing is journaled twice.

| Hook | What it does |
|---|---|
| SessionStart | the board (new chat), or the job's checkpoint (compact, resume, clear); the journal's wake-up |
| UserPromptSubmit | the message pinned word for word; the chat recorded on the board |
| PostToolUse | the action journaled; the checkpoint rewritten; a todo list on a generic job becomes its steps |
| Stop | milestone checks; the checkpoint; a background sync at most every 5 minutes |
| PreToolUse | the journal's and the board's own commands run without a permission prompt, only when the command is that call alone; opening a PR (`board pr`) keeps the normal permission check |

## The board on the PC and the phone

`board serve` and open http://127.0.0.1:7420/: columns, drag to move, a card's milestones (tick them), its next
line, summary, requirements, checkpoint, each milestone's journal, and its history.

**On GitHub, nothing to set up:** every sync writes the board as your board repo's README, by column with progress
bars and links to each job's checkpoint. Open the repo in the GitHub app on your phone (already signed in) and the
board is the first thing you see. Read-only.

**The board page on your phone** (move cards, tick milestones, write notes, with the PC off): the same page runs
from GitHub Pages and reads your private board repo with a token that only you hold.

1. Make a fine-grained token at https://github.com/settings/personal-access-tokens/new: Repository access = Only
   select repositories, your board repo; Permissions, Contents = Read and write.
2. Open the link setup printed (`…/web/#owner=<you>&repo=<board repo>`), paste the token in Settings (it stays in
   that browser), then "Add to Home Screen".

The page is static: your board goes from GitHub to your phone's browser and back, nowhere else. To host it
yourself, fork this repo and turn on GitHub Pages (branch root). An edit on the phone becomes one small file in the
board repo's `inbox/`, so the phone and the PC never write the same file; the PC's next sync applies it.

**Sync** is `git pull` / `git push` with the GitHub login, never a prompt or a login window; a failure is written
to `sync.log`. It runs when a chat ends a turn (at most every 5 minutes) and on the background timer while you are
logged in (`board schedule on|off|status [--minutes n]`). A sync with nothing new commits nothing. Sync also follows
open pull requests: a merge on GitHub moves the card.

## Where things are

| | |
|---|---|
| `~/.agentic-task-journal/` (or `ATJ_HOME`) | the board: `board.db` (SQLite, many chats at once), `checkpoints/`, `reports/`, `logs/<job>/` (every chat's pins + journal), `jobs/*.json` (cards for sync), `inbox/` |
| `<project>/.agentjournal/<session>/` | the journal: `PINNED.md`, `UPDATES.jsonl`, `JOURNAL.md` |
| `bin/setup.mjs` | setup, update, uninstall |
| `bin/board.mjs` | the board (`board help`) |
| `bin/agentjournal.mjs` | the journal: `note`, `sleep`, `update`, `same`, `pins`, `status` |
| `adapters/` | Jira, GitHub Issues and Linear: the shape of an adapter, not built yet (each becomes a skill) |

## Commands

```
board                                  overview of every project
board new "<title>" [--kind K] [--ref <folder>] [--col doing]
board resume <id>                      this chat continues job <id> (prints its checkpoint)
board tick <id> <step> | untick | skip | step <id> "<title>"
board req <id> "<requirement>"         board summary <id> "<text>"        board report <id> [--write]
board next <id> "<what comes next>"    board note <id> "<line>"           board move <id> <column>
board pr <id> [--base main] [--draft]  board pr <id> --status             board done <id>
board check [<id>]                     board list [--all]                 board show <id>
board sync [--no-push]                 board serve [--port 7420]          board kinds
board schedule on|off|status [--minutes 15]
```

## Tests

`npm test`: 17 tests on a scratch board, project and settings file; no model, no network.

## Licence

MIT. AgentJournal is the journal half of this repo; its own repository, with the measurements behind it, is
https://github.com/PiPercentHuman/agentjournal.
