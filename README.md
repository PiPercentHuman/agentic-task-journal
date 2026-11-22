# taskboard

One kanban board for every project. Claude Code chats write to it by themselves: a job is a card, its plan is a
list of milestones, every finished milestone keeps the AgentJournal lines that produced it, and a rolling
checkpoint always says where the whole job stands. A new chat continues from the checkpoint, even after the chat
that did the work has been deleted.

No dependencies: Node 22.5+ (`node:sqlite`), git.

## How the pieces fit

```
chat (Claude Code) ──hooks──▶ data/board.db (SQLite, WAL: many chats at once)
        │                         │
        │ board <cmd>             ├─▶ data/checkpoints/<id>.md   rolling checkpoint per job
        ▼                         ├─▶ data/logs/<id>/*.md        a done job's pins + journals
   AgentJournal notes  ──read──▶  └─▶ data/jobs/<id>.json        cards, written by `board sync`
   (.agentjournal/<session>)                       │
                                                   ▼  git push (private repo)
                                        GitHub ◀── phone page writes data/inbox/*.json
```

* **Job (card):** title, project, kind, ref (its folder), column (backlog, planned, doing, blocked, review, done),
  a "next" line, and fields for Jira/GitHub ids.
* **Milestones:** come from the job's kind (`templates/*.json`). `full3d-video` has the 17 steps of a channel video
  (research, plan, experiment, facts, narration, story review, voice, world, timing, preview, film, inserts, cut,
  subs, look, packaging, ship). Steps with a `done_when` file check tick themselves; the rest are ticked by the chat.
* **Milestone log:** a tick hands the step every AgentJournal line since the previous tick (topics closed +
  actions), so each milestone carries its own log.
* **Checkpoint:** rewritten after every tool call and at the end of every turn: milestones, the next line, the
  user's pins with their updated versions, topics closed, the last 25 actions, the board history. It lives in the
  board, not in the chat, so deleting the chat loses nothing.
* **Done:** `board done <id>` keeps the pins and journal of every chat that worked the job in `data/logs/<id>/`.

## Hooks (Claude Code, user settings: every project)

| Event | What happens |
|---|---|
| SessionStart (new chat) | the board: this project's open jobs, then the other projects, and how to resume |
| SessionStart (compact, resume, /clear) | the job's checkpoint, if the chat is on one |
| UserPromptSubmit | the chat is recorded; the first message of a chat with no job is reminded of the board |
| PostToolUse | the checkpoint is rewritten; a TodoWrite plan on a generic job becomes its steps |
| Stop | milestone file checks, checkpoint rewritten, background sync (every 5 min at most, once a remote is set) |
| PreToolUse (Bash/PowerShell) | the board's own commands run without a permission prompt (not `serve`) |

A chat that continues after an AgentJournal `sleep` + `/clear` writes to the same journal folder and is put back on
the same job by itself.

## Commands

```
board                                  overview
board new "<title>" --kind full3d-video --ref output/<slug>
board resume <id>                      attach this chat + print the checkpoint
board tick <id> <step> | untick | skip
board next <id> "<what comes next>"
board move <id> <column> | done <id> | check [<id>] | note <id> "<line>" | step <id> "<title>"
board list [--all] | show <id> | checkpoint <id> | kinds
board sync [--no-push]                 export, apply phone edits, commit, push
board serve [--port 7420] [--host <ip>]
```

`board` is `node D:/Claude_ws/taskboard/bin/board.mjs`.

## The page

`board serve` and open http://127.0.0.1:7420/. Columns, drag a card to move it, tap a card for its milestones (tick
them), its next line, its checkpoint, the journal of each milestone, and its history. Light and dark.

## The phone, free, through GitHub (PC on or off)

The same page runs from GitHub Pages and reads the board from a **private** GitHub repo. Your edits on the phone
become small files in `inbox/` (one per edit, so the phone and the PC never write the same file), and the PC's next
`board sync` applies them.

1. `gh auth login` on the PC.
2. A private data repo: `gh repo create taskboard-data --private`, then
   `git -C D:/Claude_ws/taskboard/data remote add origin https://github.com/<you>/taskboard-data.git` and `board sync`.
3. The page: push this repo (code only; `data/` is ignored) and turn on GitHub Pages from the branch root; the page
   is then at `https://<you>.github.io/taskboard/web/`. Pages on a free account needs a public repo; it carries no
   data, and the token never leaves the phone's browser.
4. On the phone: a fine-grained token for **taskboard-data only**, Contents read and write. Open the Pages URL, put
   owner, repo and token in Settings, then "Add to Home Screen".
5. Nothing to approve after that. Sync is plain `git push`/`pull` with the GitHub login Windows already stores; it
   never opens a prompt or a login window (it logs a failure to `data/sync.log` instead). It runs by itself:
   * at the end of every chat turn, in the background, at most every 5 minutes (`TASKBOARD_SYNC_MINUTES`);
   * on a timer, so phone edits land while no chat is open:
     `schtasks /create /sc minute /mo 10 /tn taskboard-sync /tr "node D:\Claude_ws\taskboard\bin\board.mjs sync"`.

   The phone signs in once: the token is saved in its browser.

## Ticket systems

`adapters/` has stubs for Jira, GitHub Issues and Linear with one shape (`mapColumn`, `unmapStatus`, `pull`,
`push`). Nothing is fetched yet; each becomes a skill. A card's `external` field holds its ids there.

## Tests

`npm test`: a scratch board, no model.
