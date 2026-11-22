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

## Install (Claude Code, every project)

```
git clone https://github.com/PiPercentHuman/agentic-task-journal
node agentic-task-journal/bin/install.mjs          # adds the hooks to ~/.claude/settings.json (a copy is kept)
```

New sessions pick the hooks up. `--uninstall` takes them out. In a project that already registers its own
AgentJournal hook, the shared one steps aside, so nothing is journaled twice.

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

The same page runs from GitHub Pages and reads the board from a **private** repo, so the phone sees it with the PC
off. An edit on the phone becomes one small file in that repo's `inbox/`, so the phone and the PC never write the
same file; the PC's next sync applies it.

1. `gh auth login` on the PC.
2. Make the board's data a private repo:
   `gh repo create task-journal-data --private`, then
   `git -C ~/.agentic-task-journal remote add origin https://github.com/<you>/task-journal-data.git` and `board sync`.
3. Turn on GitHub Pages for your fork of this repo (branch root). The page is at
   `https://<you>.github.io/agentic-task-journal/web/`; it carries no data.
4. On the phone: a fine-grained token for the data repo only, Contents read and write. Open the page, put owner,
   repo and token in Settings (kept in that browser only), then "Add to Home Screen".

Sync is `git pull` / `git push` with the login git already has, never a prompt or a login window; a failure is
written to `sync.log`. It runs at the end of chat turns (at most every 5 minutes, `TASKBOARD_SYNC_MINUTES`) and,
for edits made while no chat is open, on a timer if you add one
(`schtasks /create /sc minute /mo 10 /tn atj-sync /tr "node <path>\bin\board.mjs sync"`). Sync also follows open
pull requests: a merge on GitHub moves the card.

## Where things are

| | |
|---|---|
| `~/.agentic-task-journal/` (or `ATJ_HOME`) | the board: `board.db` (SQLite, many chats at once), `checkpoints/`, `reports/`, `logs/<job>/` (every chat's pins + journal), `jobs/*.json` (cards for sync), `inbox/` |
| `<project>/.agentjournal/<session>/` | the journal: `PINNED.md`, `UPDATES.jsonl`, `JOURNAL.md` |
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
```

## Tests

`npm test`: 15 tests on a scratch board, project and settings file; no model, no network.

## Licence

MIT. AgentJournal is the journal half of this repo; its own repository, with the measurements behind it, is
https://github.com/PiPercentHuman/agentjournal.
