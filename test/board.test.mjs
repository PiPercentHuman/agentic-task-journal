// node --test test/*.test.mjs   (no model, no network: a scratch board, a scratch project, a scratch settings file)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "atj-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "atjp-"));
const env = { ...process.env, ATJ_HOME: home, CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: "s1", AGENTJOURNAL_ROOT: path.join(proj, ".agentjournal"), TASKBOARD_SYNC_MINUTES: "0" };
const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "board.mjs");
const HOOK = path.join(ROOT, "hooks", "board-hook.mjs");
const board = (...a) => execFileSync("node", [CLI, ...a], { env, encoding: "utf8" });
const boardFails = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const hook = (action, ev, e = env) => execFileSync("node", [HOOK, action], { env: e, input: JSON.stringify(ev), encoding: "utf8" });

// A journal for session s1, as AgentJournal writes it.
const jdir = path.join(proj, ".agentjournal", "s1");
fs.mkdirSync(jdir, { recursive: true });
fs.writeFileSync(path.join(jdir, "PINNED.md"), "### 1 (2026-11-22 10:00)\nexport the invoices as CSV\n\n### 2 (2026-11-22 10:05, after action 2)\nuse semicolons\n\n");
fs.writeFileSync(path.join(jdir, "UPDATES.jsonl"), JSON.stringify({ pin: 1, by: 2, text: "export the invoices as CSV with semicolons as the separator" }) + "\n");
fs.writeFileSync(path.join(jdir, "JOURNAL.md"), "1. Read src/export.js\n2. SLEEP requirements clear: CSV, semicolons\n");

test("a job from a kind gets its milestones, and a tick gets the journal so far", () => {
	board("new", "Invoice CSV export", "--kind", "feature");
	assert.match(board("tick", "1", "requirements"), /1\/9/);
	assert.match(board("show", "1"), /\[x\] 1\. Requirements written/);
});

test("the next tick only gets what was journaled after the last one; the checkpoint has the pins as they stand", () => {
	fs.appendFileSync(path.join(jdir, "JOURNAL.md"), "3. Edit src/export.js\n4. Bash npm test\n5. NOTE kept the old JSON export beside it\n");
	board("tick", "1", "plan");
	const cp = fs.readFileSync(path.join(home, "checkpoints", "1.md"), "utf8");
	assert.match(cp, /2\/9 milestones/);
	assert.match(cp, /SLEEP requirements clear/);
	assert.match(cp, /1\.1 now: export the invoices as CSV with semicolons/);
});

test("a new chat that resumes gets the checkpoint; a compact wake-up gets it from the hook", () => {
	const out = execFileSync("node", [CLI, "resume", "1"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "s2" }, encoding: "utf8" });
	assert.match(out, /# Checkpoint: #1 Invoice CSV export/);
	const wake = JSON.parse(hook("start", { session_id: "s2", source: "compact" }));
	assert.match(wake.hookSpecificOutput.additionalContext, /continues job #1/);
});

test("a fresh chat sees the board and how to finish a job", () => {
	const intro = JSON.parse(hook("start", { session_id: "s3", source: "startup" })).hookSpecificOutput.additionalContext;
	assert.match(intro, /#1 \[doing\] Invoice CSV export/);
	assert.match(intro, /summary <id>/);
});

test("requirements and a summary make the end-of-task report", () => {
	board("req", "1", "Invoices export as CSV, semicolon-separated");
	board("req", "1", "The JSON export keeps working");
	board("summary", "1", "Added a CSV exporter beside the JSON one; npm test passes.");
	const r = board("report", "1");
	assert.match(r, /## Summary\n\nAdded a CSV exporter/);
	assert.match(r, /1\. Invoices export as CSV, semicolon-separated\n2\. The JSON export keeps working/);
	assert.match(r, /Pin 1, as it stands now:\*\* export the invoices as CSV with semicolons/);
	assert.match(r, /## Files changed\n\n- src\/export\.js/);
	assert.match(r, /`npm test`/);
	assert.match(r, /kept the old JSON export beside it/);
	assert.match(board("show", "1"), /\[x\] 9\. Summary written/); // the summary milestone ticks itself
});

test("a project's own kinds are offered beside the built-in ones", () => {
	fs.mkdirSync(path.join(proj, ".atj", "templates"), { recursive: true });
	fs.writeFileSync(path.join(proj, ".atj", "templates", "release.json"), JSON.stringify({ kind: "release", description: "x", steps: [{ title: "tag" }, { title: "notes", done_when: { exists: "NOTES.md" } }] }));
	assert.match(board("kinds"), /^release: x/m);
	board("new", "Release 2.0", "--kind", "release", "--ref", ".");
	fs.writeFileSync(path.join(proj, "NOTES.md"), "n");
	board("check", "2");
	assert.match(board("show", "2"), /\[x\] 2\. notes/);
});

test("a pull request is refused on the base branch", () => {
	const g = (...a) => execFileSync("git", ["-C", proj, ...a], { encoding: "utf8" });
	g("init", "-q", "-b", "main");
	g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
	const r = boardFails("pr", "2");
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /commit the work on a branch first/);
});

test("phone edits in the inbox are applied by sync and the cards exported", () => {
	board("sync", "--no-push");
	fs.writeFileSync(path.join(home, "inbox", "20261122T1200-a.json"), JSON.stringify({ op: "move", job: 1, column: "review" }));
	fs.writeFileSync(path.join(home, "inbox", "20261122T1201-b.json"), JSON.stringify({ op: "bogus", job: 1 }));
	assert.match(board("sync", "--no-push"), /1 phone edit\(s\) applied/);
	const card = JSON.parse(fs.readFileSync(path.join(home, "jobs", "1.json"), "utf8"));
	assert.equal(card.column, "review");
	assert.equal(card.requirements.length, 2);
	assert.ok(fs.existsSync(path.join(home, "inbox", "20261122T1201-b.json.rejected")));
});

test("only the board call alone runs without a prompt, and never one that opens a PR", () => {
	const ask = (command) => hook("allow", { session_id: "x", tool_input: { command } });
	assert.match(ask(`node "${CLI}" tick 1 build`), /"allow"/);
	assert.match(ask(`node "${CLI}" sync`), /"allow"/);
	assert.match(ask(`node "${CLI}" pr 1 --status`), /"allow"/);
	assert.equal(ask(`node "${CLI}" pr 1`), "");
	assert.equal(ask(`node "${CLI}" serve`), "");
	assert.equal(ask(`node "${CLI}" note 1 "$(whoami)"`), "");
	assert.equal(ask(`node "${CLI}" list; rm -rf x`), "");
});

test("done prints the report and keeps every chat's journal", () => {
	const out = board("done", "1");
	assert.match(out, /# Invoice CSV export \(#1\)/);
	assert.ok(fs.existsSync(path.join(home, "logs", "1", "s1.md")));
	assert.ok(fs.existsSync(path.join(home, "reports", "1.md")));
});

test("the shared AgentJournal hook steps aside in a project that has its own", () => {
	const AJ = path.join(ROOT, "hooks", "agentjournal-hook.mjs");
	const p2 = fs.mkdtempSync(path.join(os.tmpdir(), "atjq-"));
	const e2 = { ...process.env, CLAUDE_PROJECT_DIR: p2 };
	delete e2.AGENTJOURNAL_ROOT;
	const pin = () => execFileSync("node", [AJ, "pin"], { env: e2, input: JSON.stringify({ session_id: "z", prompt: "hello", hook_event_name: "UserPromptSubmit" }), encoding: "utf8" });
	pin();
	assert.ok(fs.existsSync(path.join(p2, ".agentjournal", "z", "PINNED.md")));
	fs.rmSync(path.join(p2, ".agentjournal"), { recursive: true });
	fs.mkdirSync(path.join(p2, ".claude"));
	fs.writeFileSync(path.join(p2, ".claude", "settings.json"), '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node .claude/hooks/agentjournal-hook.mjs pin"}]}]}}');
	pin();
	assert.ok(!fs.existsSync(path.join(p2, ".agentjournal", "z", "PINNED.md")));
});

test("install adds the hooks once, keeps the rest of the settings, and uninstall takes them out", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atjs-")), "settings.json");
	fs.writeFileSync(f, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
	const inst = (...a) => execFileSync("node", [path.join(ROOT, "bin", "install.mjs"), "--settings", f, ...a], { encoding: "utf8" });
	inst(); inst();
	const s = JSON.parse(fs.readFileSync(f, "utf8"));
	assert.equal(s.theme, "dark");
	assert.equal(s.hooks.Stop.length, 2);
	assert.equal(s.hooks.PostToolUse.length, 1);
	inst("--uninstall");
	const u = JSON.parse(fs.readFileSync(f, "utf8"));
	assert.deepEqual(Object.keys(u.hooks), ["Stop"]);
	assert.equal(u.hooks.Stop.length, 1);
});

test("a public report (a PR body) leaves out the user's own words and the local paths", async () => {
	process.env.ATJ_HOME = home;
	const { report } = await import("../lib/report.mjs");
	const r = report(1, { public: true, files: ["src/csv.js"] });
	assert.doesNotMatch(r, /In the user's words/);
	assert.doesNotMatch(r, /with semicolons as the separator/);
	assert.doesNotMatch(r, /pins and journals:/);
	assert.match(r, /## Files changed\n\n- src\/csv\.js/);
	assert.match(r, /1\. Invoices export as CSV/);
	assert.match(report(1), /with semicolons as the separator/); // the local report keeps them
});

test("a job's report only reads the journal from where the job began in that chat", () => {
	fs.appendFileSync(path.join(jdir, "JOURNAL.md"), "6. NOTE something about another job\n");
	board("new", "Second job", "--kind", "generic");
	fs.appendFileSync(path.join(jdir, "JOURNAL.md"), "7. Edit src/second.js\n");
	const r = board("report", "3");
	assert.match(r, /src\/second\.js/);
	assert.doesNotMatch(r, /src\/export\.js/);
	assert.doesNotMatch(r, /something about another job/);
});

test("a PR body carries nothing read from the journal", async () => {
	process.env.ATJ_HOME = home;
	const { report } = await import("../lib/report.mjs");
	const r = report(1, { public: true, files: [] });
	for (const h of ["## Decisions", "## Verification", "Topics closed", "kept the old JSON export", "`npm test`"]) assert.ok(!r.includes(h), h);
	assert.doesNotMatch(r, /Pull request opened/);
});

test("background sync is planned with each system's own scheduler", async () => {
	const { plan } = await import("../lib/schedule.mjs");
	const w = plan({ minutes: 15, platform: "win32", node: "C:/node.exe", root: "C:/atj" });
	assert.equal(w.kind, "Windows Task Scheduler");
	assert.deepEqual(w.on[0][1].slice(0, 6), ["/create", "/f", "/sc", "minute", "/mo", "15"]);
	assert.match(w.on[0][1].at(-1), /wscript\.exe \/\/nologo ".*sync-hidden\.vbs" "C:\/node\.exe"/);
	const m = plan({ minutes: 15, platform: "darwin", node: "/usr/local/bin/node", root: "/atj", home: "/Users/u" });
	assert.match(m.files[0].path, /LaunchAgents[\/]com\.agentic-task-journal\.sync\.plist$/);
	assert.match(m.files[0].content, /<integer>900<\/integer>/);
	assert.match(plan({ minutes: 15, platform: "linux", node: "/usr/bin/node", root: "/atj" }).cron, /^\*\/15 \* \* \* \* "\/usr\/bin\/node" ".*board\.mjs" sync/);
	assert.match(plan({ minutes: 120, platform: "linux", node: "n", root: "/atj" }).cron, /^0 \*\/2 \* \* \*/);
});

test("setup --dry-run walks every step and changes nothing", () => {
	const settings = path.join(os.homedir(), ".claude", "settings.json");
	const before = fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : null;
	const out = execFileSync("node", [path.join(ROOT, "bin", "setup.mjs"), "--dry-run", "--no-github"], { env: { ...env, ATJ_HOME: path.join(home, "dry") }, encoding: "utf8" });
	for (const s of ["1. Prerequisites", "2. Claude Code hooks", "3. The board's home", "4. A private GitHub repo", "5. Background sync", "6. Seeing the board"]) assert.ok(out.includes(s), s);
	assert.ok(!fs.existsSync(path.join(home, "dry", ".git")));
	assert.equal(fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : null, before);
});
