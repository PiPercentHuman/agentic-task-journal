#!/usr/bin/env node
// Install Agentic Task Journal into Claude Code for every project: the AgentJournal hooks (pins, journal, sleep) and
// the board hooks (overview, checkpoint, milestones, sync), in ~/.claude/settings.json. Everything already in that
// file is kept; a copy is saved beside it first. Run it again to update; `--uninstall` takes the hooks out.
//
//   node bin/install.mjs [--settings <file>] [--uninstall]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks").replace(/\\/g, "/");
const i = process.argv.indexOf("--settings");
const file = i > 0 ? process.argv[i + 1] : path.join(os.homedir(), ".claude", "settings.json");
const uninstall = process.argv.includes("--uninstall");

const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-atj`);
const ours = (entry) => /agentic-task-journal\/hooks\/|taskboard\/hooks\/board-hook\.mjs/.test(JSON.stringify(entry).replace(/\\\\/g, "/"));
const h = (script, action) => ({ type: "command", command: "node", args: [`${HOOKS}/${script}`, action], timeout: 10 });
const AJ = "agentjournal-hook.mjs";
const BOARD = "board-hook.mjs";
const wanted = {
	SessionStart: [{ matcher: "startup|compact|resume|clear", hooks: [h(AJ, "wake"), h(BOARD, "start")] }],
	UserPromptSubmit: [{ hooks: [h(AJ, "pin"), h(BOARD, "prompt")] }],
	PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [h(AJ, "ask"), h(BOARD, "allow")] }],
	PostToolUse: [{ matcher: "*", hooks: [h(AJ, "journal"), h(BOARD, "tool")] }],
	PostToolUseFailure: [{ matcher: "*", hooks: [h(AJ, "journal")] }],
	Stop: [{ hooks: [h(AJ, "stop"), h(BOARD, "stop")] }],
};
settings.hooks ??= {};
for (const event of new Set([...Object.keys(settings.hooks), ...Object.keys(wanted)])) {
	const kept = (settings.hooks[event] ?? []).filter((e) => !ours(e));
	const next = uninstall ? kept : [...kept, ...(wanted[event] ?? [])];
	if (next.length) settings.hooks[event] = next;
	else delete settings.hooks[event];
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`${uninstall ? "Removed from" : "Installed in"} ${file} (a copy of the old file: ${file}.before-atj)`);
if (!uninstall) console.log(`Hooks: ${HOOKS}. New Claude Code sessions pick them up. The board: node ${HOOKS.replace(/hooks$/, "bin")}/board.mjs`);
