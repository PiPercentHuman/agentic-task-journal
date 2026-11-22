// node --test test/   (no model, a scratch board)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tbp-"));
const env = { ...process.env, TASKBOARD_HOME: home, CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: "s1", AGENTJOURNAL_ROOT: path.join(proj, ".agentjournal") };
const CLI = path.join(import.meta.dirname, "..", "bin", "board.mjs");
const HOOK = path.join(import.meta.dirname, "..", "hooks", "board-hook.mjs");
const board = (...a) => execFileSync("node", [CLI, ...a], { env, encoding: "utf8" });
const hook = (action, ev) => execFileSync("node", [HOOK, action], { env, input: JSON.stringify(ev), encoding: "utf8" });

// A journal for session s1, as AgentJournal writes it.
const jdir = path.join(proj, ".agentjournal", "s1");
fs.mkdirSync(jdir, { recursive: true });
fs.writeFileSync(path.join(jdir, "PINNED.md"), "### 1 (2026-11-22 10:00)\nbuild the thing\n\n");
fs.writeFileSync(path.join(jdir, "JOURNAL.md"), "1. Read a.txt\n2. SLEEP research done: 3 sources\n");

test("a job from a kind gets its milestones, and a tick gets the journal so far", () => {
	board("new", "Build the thing", "--kind", "code");
	const out = board("tick", "1", "understand");
	assert.match(out, /1\/5/);
	const log = board("show", "1");
	assert.match(log, /\[x\] 1\. Read the code/);
	assert.match(log, /log: \d+ lines/);
});

test("the next tick only gets what was journaled after the last one", () => {
	fs.appendFileSync(path.join(jdir, "JOURNAL.md"), "3. Edit b.txt\n");
	board("tick", "1", "build");
	const cp = fs.readFileSync(path.join(home, "checkpoints", "1.md"), "utf8");
	assert.match(cp, /2\/5 milestones/);
	assert.match(cp, /SLEEP research done/);
	assert.match(cp, /pin 1: build the thing/);
});

test("a new chat that resumes gets the checkpoint; a compact wake-up gets it from the hook", () => {
	const env2 = { ...env, CLAUDE_CODE_SESSION_ID: "s2" };
	const out = execFileSync("node", [CLI, "resume", "1"], { env: env2, encoding: "utf8" });
	assert.match(out, /# Checkpoint: #1 Build the thing/);
	const wake = JSON.parse(hook("start", { session_id: "s2", source: "compact" }));
	assert.match(wake.hookSpecificOutput.additionalContext, /continues job #1/);
});

test("a fresh chat sees the board", () => {
	const intro = JSON.parse(hook("start", { session_id: "s3", source: "startup" }));
	assert.match(intro.hookSpecificOutput.additionalContext, /#1 \[doing\] Build the thing/);
});

test("phone edits in the inbox are applied by sync and the cards exported", () => {
	board("sync", "--no-push");
	fs.writeFileSync(path.join(home, "inbox", "20261122T1200-a.json"), JSON.stringify({ op: "move", job: 1, column: "review" }));
	fs.writeFileSync(path.join(home, "inbox", "20261122T1201-b.json"), JSON.stringify({ op: "bogus", job: 1 }));
	const out = board("sync", "--no-push");
	assert.match(out, /1 phone edit\(s\) applied/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "jobs", "1.json"), "utf8")).column, "review");
	assert.ok(fs.existsSync(path.join(home, "inbox", "20261122T1201-b.json.rejected")));
});

test("only the board call alone is allowed without a prompt", () => {
	const ask = (command) => hook("allow", { session_id: "x", tool_input: { command } });
	assert.match(ask(`node "${CLI}" tick 1 build`), /"allow"/);
	assert.equal(ask(`node "${CLI}" sync`), "");
	assert.equal(ask(`node "${CLI}" note 1 "$(whoami)"`), "");
	assert.equal(ask(`node "${CLI}" list; rm -rf x`), "");
});

test("done keeps every chat's journal as the job's log", () => {
	board("done", "1");
	assert.ok(fs.existsSync(path.join(home, "logs", "1", "s1.md")));
});
