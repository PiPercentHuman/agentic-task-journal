#!/usr/bin/env node
// Agentic Task Journal, set up in one go, for anyone given this repo:
//
//   node bin/setup.mjs                 everything below, with the defaults
//   node bin/setup.mjs --board-repo my-board --minutes 30
//   node bin/setup.mjs --no-github     a local board only (no phone, no sync)
//   node bin/setup.mjs --no-schedule   no background sync on a timer (chats still sync when they end a turn)
//   node bin/setup.mjs --dry-run       say what would be done, do nothing
//   node bin/setup.mjs --uninstall     take the hooks and the timer out (the board and its repo are kept)
//
// 1. checks Node 22.5+ and git          4. a PRIVATE GitHub repo for the board (gh: logs in if needed), first sync
// 2. installs the Claude Code hooks      5. background sync every 15 minutes while you are logged in
// 3. the board's home (~/.agentic-task-journal, or ATJ_HOME), a git repo    6. prints how to see the board, PC and phone
// Run it again at any time: every step keeps what is already there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const value = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const DRY = flag("dry-run");
const minutes = Number(value("minutes", 15));
const repoName = value("board-repo", "taskboard");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const say = (s) => console.log(s);
const step = (n, s) => say(`\n${n}. ${s}`);
const ok = (s) => say(`   ok  ${s}`);
const skip = (s) => say(`   --  ${s}`);
const fail = (s) => { say(`   !!  ${s}`); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
const has = (cmd) => run(cmd, ["--version"]).status === 0;

say(`Agentic Task Journal ${pkg.version} - setup${DRY ? " (dry run: nothing is changed)" : ""}`);

// 1. prerequisites
step(1, "Prerequisites");
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) fail(`Node ${process.versions.node}: 22.5 or newer is needed (node:sqlite). https://nodejs.org`);
ok(`Node ${process.versions.node}`);
if (!has("git")) fail("git is not installed: https://git-scm.com");
ok("git");

if (flag("uninstall")) {
	step(2, "Hooks out of Claude Code");
	if (!DRY) run(process.execPath, [path.join(ROOT, "bin", "install.mjs"), "--uninstall"], { stdio: "inherit" });
	step(3, "Background sync off");
	if (!DRY) { const { apply } = await import("../lib/schedule.mjs"); ok(apply(false, { minutes })); }
	say("\nThe board, its history and its GitHub repo are kept. Delete them yourself if you want them gone.");
	process.exit(0);
}

// 2. hooks
step(2, "Claude Code hooks (every project)");
if (DRY) skip("would add the AgentJournal and board hooks to ~/.claude/settings.json");
else {
	const r = run(process.execPath, [path.join(ROOT, "bin", "install.mjs")]);
	if (r.status !== 0) fail(r.stderr || r.stdout);
	ok(r.stdout.trim().split("\n")[0]);
}

// 3. the board's home
step(3, "The board's home");
const S = await import("../lib/store.mjs");
const sync = await import("../lib/sync.mjs");
if (DRY) skip(`would create ${S.HOME} (a git repo; board.db stays out of git)`);
else { S.open(); sync.ensureRepo(); ok(S.HOME); }

// 4. GitHub
step(4, "A private GitHub repo for the board");
const git = (...a) => run("git", ["-C", S.HOME, ...a]);
let boardUrl = null;
let owner = null;
const remote = () => (fs.existsSync(path.join(S.HOME, ".git")) ? git("remote", "get-url", "origin").stdout.trim() : "");
if (flag("no-github")) skip("--no-github: a local board only (no phone, no sync)");
else if (!has("gh")) skip("the GitHub CLI is not installed (https://cli.github.com); install it and run setup again. The board works locally meanwhile.");
else {
	if (run("gh", ["auth", "status"]).status !== 0) {
		if (DRY) skip("would run: gh auth login (a code to enter on github.com)");
		else if (process.stdin.isTTY) { say("   GitHub login: follow the steps below."); run("gh", ["auth", "login", "--web", "--git-protocol", "https"], { stdio: "inherit" }); }
		else skip("not logged in to GitHub: run `gh auth login`, then setup again");
	}
	if (run("gh", ["auth", "status"]).status === 0) {
		owner = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
		if (!DRY) run("gh", ["auth", "setup-git"]); // git pushes with the gh login: no prompts, no login windows
		const existing = remote();
		if (existing) {
			ok(`already synced to ${existing}`);
			const m = existing.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
			if (m) { owner = m[1]; boardUrl = `https://github.com/${m[1]}/${m[2]}`; }
		} else {
			const full = `${owner}/${repoName}`;
			const view = run("gh", ["repo", "view", full, "--json", "visibility", "--jq", ".visibility"]);
			if (view.status === 0 && view.stdout.trim() !== "PRIVATE") fail(`${full} exists and is ${view.stdout.trim().toLowerCase()}: the board holds your messages and journals, so it must be private. Pick another name with --board-repo <name>.`);
			if (DRY) skip(view.status === 0 ? `would use the existing private ${full}` : `would create the private repo ${full}`);
			else {
				if (view.status !== 0) {
					const c = run("gh", ["repo", "create", full, "--private", "--description", "My task board (Agentic Task Journal): cards, checkpoints, reports. Private."]);
					if (c.status !== 0) fail(c.stderr);
					ok(`created ${full} (private)`);
				} else ok(`using the existing private ${full}`);
				git("remote", "add", "origin", `https://github.com/${full}.git`);
			}
			boardUrl = `https://github.com/${full}`;
		}
		if (!DRY) ok(sync.sync({ push: true }));
	}
}

// 5. background sync
step(5, `Background sync every ${minutes} minutes`);
const sched = await import("../lib/schedule.mjs");
if (flag("no-schedule")) skip("--no-schedule: chats still sync when they end a turn");
else if (!remote() && !DRY) skip("no GitHub repo for the board, so nothing to sync with");
else if (DRY) skip(`would turn on: ${sched.plan({ minutes }).kind}`);
else ok(sched.apply(true, { minutes }));

// 6. how to see it
step(6, "Seeing the board");
const page = pkg.homepage || "https://pipercenthuman.github.io/agentic-task-journal/web/";
const BOARD = `node "${path.join(ROOT, "bin", "board.mjs").replace(/\\/g, "/")}"`;
say(`   On this computer:  ${BOARD} serve   then open http://127.0.0.1:7420/`);
say(`   In a terminal:     ${BOARD}`);
if (boardUrl) {
	const repo = boardUrl.split("/").pop();
	say(`   On GitHub (the app on your phone, read-only, nothing to set up): ${boardUrl}`);
	say(`   The board page on your phone (move cards, tick milestones):`);
	say(`     1. make a token: https://github.com/settings/personal-access-tokens/new`);
	say(`        Repository access: Only select repositories -> ${repo}; Permissions: Contents = Read and write`);
	say(`     2. open ${page}#owner=${owner}&repo=${repo}  and paste the token in Settings; then Add to Home Screen`);
}
say(`\nDone. New Claude Code sessions see the board. \`${BOARD} help\` lists the commands.`);
