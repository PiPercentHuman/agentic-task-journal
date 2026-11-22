// Reading AgentJournal's notes (PINNED.md, UPDATES.jsonl, JOURNAL.md) for a session. The board never writes them.
import fs from "node:fs";
import path from "node:path";

const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

// Where AgentJournal keeps a session's notes, the same way its hook finds them: the project's .agentjournal, the
// session's own folder, or the folder of the session it continues after a /clear (THREAD).
export function journalRoot(cwd) {
	if (process.env.AGENTJOURNAL_ROOT) return process.env.AGENTJOURNAL_ROOT;
	if (process.env.CLAUDE_PROJECT_DIR) return path.join(process.env.CLAUDE_PROJECT_DIR, ".agentjournal");
	for (let dir = path.resolve(cwd || "."); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".agentjournal"))) return path.join(dir, ".agentjournal");
		if (path.dirname(dir) === dir) return null;
	}
}
export function journalDir(cwd, sessionId) {
	const root = journalRoot(cwd);
	if (!root || !sessionId) return null;
	const own = path.join(root, sessionId);
	return (read(path.join(own, "THREAD")).trim() || own).replace(/\\/g, "/");
}

export function lines(dir) {
	return read(dir && path.join(dir, "JOURNAL.md")).split("\n").filter((l) => /^\d+\. /.test(l));
}
export const topics = (dir) => lines(dir).filter((l) => /^\d+\. SLEEP /.test(l));

// The pins, one entry each, with the updated versions the agent wrote under them.
export function pins(dir) {
	const blocks = read(dir && path.join(dir, "PINNED.md")).trim().split(/\n(?=### )/).filter(Boolean);
	const updates = read(dir && path.join(dir, "UPDATES.jsonl")).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	return blocks.map((b) => {
		const [head, ...body] = b.split("\n");
		const n = Number((head.match(/^### (\d+)/) ?? [])[1]);
		return { n, head: head.replace(/^### /, ""), text: body.join("\n").trim(), updates: updates.filter((u) => u.pin === n).map((u) => u.text) };
	});
}

// Everything in a journal folder as one Markdown log (what a finished job keeps).
export function snapshot(dir) {
	const p = pins(dir);
	return [
		`## Pins (${dir})`,
		...p.map((x) => `### ${x.head}\n${x.text}${x.updates.map((u, k) => `\n\n#### ${x.n}.${k + 1} updated\n${u}`).join("")}`),
		"",
		"## Journal",
		...lines(dir),
		"",
	].join("\n");
}
