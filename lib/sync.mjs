// Sync through git. data/ is its own git repository (board.db is never committed):
//   data/jobs/<id>.json         every card, written by `board sync` (local is the one writer of these)
//   data/checkpoints/<id>.md    the rolling checkpoint of each job
//   data/logs/<id>/*.md         a finished job's AgentJournal pins + journal
//   data/inbox/*.json           edits made elsewhere (the phone page): one small file per edit, so two devices
//                               never write the same file and a pull never conflicts. `board sync` applies them in
//                               time order, deletes them, and writes the cards again.
// With a remote set (`git -C data remote add origin <private repo>`), sync pulls first and pushes after.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as S from "./store.mjs";
import * as B from "./board.mjs";

const git = (...a) => execFileSync("git", ["-C", S.HOME, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function cardJson(j) {
	return {
		id: j.id, project: j.project_name, projectPath: j.project_path, title: j.title, kind: j.kind, ref: j.ref, column: j.col,
		priority: j.priority, labels: JSON.parse(j.labels || "[]"), external: JSON.parse(j.external || "{}"), next: j.next,
		created: j.created, updated: j.updated, doneAt: j.done_at, progress: B.progress(j.id),
		steps: S.steps(j.id).map((s) => ({ pos: s.pos, key: s.key, title: s.title, state: s.state, doneAt: s.done_at, auto: !!s.done_when, log: s.log })),
		chats: S.sessionsOf(j.id).map((s) => ({ id: s.session_id, started: s.started, lastSeen: s.last_seen })),
		history: S.events(j.id, 40).map((e) => ({ at: e.at, kind: e.kind, text: e.text })),
	};
}
export const board = () => ({ columns: S.COLUMNS, projects: S.projects().map((p) => ({ id: p.id, name: p.name, path: p.path })), jobs: S.jobs().map(cardJson), at: S.now() });

// One edit from elsewhere. Same verbs as the CLI, so the phone can do what a chat can, except start one.
export function apply(op, by = "inbox") {
	const id = Number(op.job);
	if (!S.job(id)) throw new Error(`no job ${op.job}`);
	switch (op.op) {
		case "move": op.column === "done" ? B.finish(id, null) : S.move(id, op.column, null); break;
		case "tick": B.tick(id, op.step, null, `(${by})`); break;
		case "untick": S.tick(id, op.step, null, null, "open"); break;
		case "skip": S.tick(id, op.step, null, null, "skipped"); break;
		case "next": S.setField(id, "next", String(op.text ?? ""), null); break;
		case "note": S.event(id, "note", `${by}: ${op.text ?? ""}`, null); break;
		case "title": S.setField(id, "title", String(op.text ?? ""), null); break;
		case "priority": S.setField(id, "priority", Number(op.value ?? 2), null); break;
		default: throw new Error(`unknown op ${op.op}`);
	}
	B.writeCheckpoint(id, null);
}

export function exportAll() {
	const dir = path.join(S.HOME, "jobs");
	fs.mkdirSync(dir, { recursive: true });
	const b = board();
	for (const j of b.jobs) fs.writeFileSync(path.join(dir, `${j.id}.json`), JSON.stringify(j, null, 1));
	fs.writeFileSync(path.join(S.HOME, "board.json"), JSON.stringify({ columns: b.columns, projects: b.projects, at: b.at, jobs: b.jobs.map(({ history, chats, ...j }) => ({ ...j, steps: j.steps.map(({ log, ...s }) => s) })) }, null, 1));
	return b.jobs.length;
}

function applyInbox() {
	const dir = path.join(S.HOME, "inbox");
	if (!fs.existsSync(dir)) return 0;
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	let n = 0;
	for (const f of files) {
		const file = path.join(dir, f);
		try { apply(JSON.parse(fs.readFileSync(file, "utf8")), "phone"); n++; } catch (e) { fs.renameSync(file, `${file}.rejected`); console.error(`board sync: ${f} not applied: ${e.message}`); continue; }
		fs.unlinkSync(file);
	}
	return n;
}

export function ensureRepo() {
	if (fs.existsSync(path.join(S.HOME, ".git"))) return;
	git("init", "-q");
	fs.writeFileSync(path.join(S.HOME, ".gitignore"), "board.db\nboard.db-*\n*.rejected\n");
	fs.mkdirSync(path.join(S.HOME, "inbox"), { recursive: true });
	fs.writeFileSync(path.join(S.HOME, "inbox", ".keep"), "");
}

export function sync({ push = true } = {}) {
	ensureRepo();
	const remote = (() => { try { return git("remote"); } catch { return ""; } })();
	const report = [];
	if (remote) {
		try { git("pull", "-q", "--rebase", "--autostash", "origin", git("branch", "--show-current") || "main"); report.push("pulled"); } catch (e) { report.push(`pull failed: ${e.stderr || e.message}`.trim()); }
	}
	const applied = applyInbox();
	if (applied) report.push(`${applied} phone edit(s) applied`);
	report.push(`${exportAll()} card(s) exported`);
	git("add", "-A");
	const changed = git("status", "--porcelain");
	if (changed) { git("commit", "-q", "-m", `board sync ${S.now()}`); report.push("committed"); } else report.push("nothing to commit");
	if (remote && push) {
		try { git("push", "-q", "origin", "HEAD"); report.push("pushed"); } catch (e) { report.push(`push failed: ${e.stderr || e.message}`.trim()); }
	} else if (!remote) report.push("no remote set (local only)");
	return `board sync: ${report.join(", ")}`;
}
