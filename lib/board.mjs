// What the board does with the store: templates, milestone checks, logs from AgentJournal, the rolling checkpoint,
// the overview a new chat sees. The CLI, the hooks and the web server all go through here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./store.mjs";
import * as J from "./journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, "..", "templates");
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);

export function templates() {
	return fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(TEMPLATES, f), "utf8")));
}
export const template = (kind) => templates().find((t) => t.kind === kind);

// ---- milestone checks (done_when) -------------------------------------------------------------------------------
// exists: the file is there.  edited: it is there and differs from the template copy (or there is no copy).
// glob: some file matches.  changed: some matching file is not the template's own copy.  Paths are under the job's ref.
function globFiles(base, pattern) {
	const parts = pattern.split("/");
	let found = [base];
	for (const part of parts) {
		const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		found = found.flatMap((d) => {
			if (!part.includes("*")) return fs.existsSync(path.join(d, part)) ? [path.join(d, part)] : [];
			try { return fs.readdirSync(d).filter((n) => re.test(n)).map((n) => path.join(d, n)); } catch { return []; }
		});
	}
	return found.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}
function sameAsTemplate(file, rel, job, tpl) {
	if (!tpl?.template) return false;
	const slug = path.basename(job.ref || "");
	const relTpl = rel.split(slug).join("__SLUG__");
	const original = read(path.join(job.project_path, tpl.template, relTpl));
	if (original == null) return false;
	return read(file) === original.replaceAll("__SLUG__", slug);
}
export function met(job, when) {
	if (!when || !job.ref) return false;
	const tpl = template(job.kind);
	const base = path.resolve(job.project_path, job.ref);
	if (when.exists) return fs.existsSync(path.join(base, when.exists));
	if (when.glob) return globFiles(base, when.glob).length > 0;
	if (when.edited) {
		const f = path.join(base, when.edited);
		return fs.existsSync(f) && !sameAsTemplate(f, when.edited, job, tpl);
	}
	if (when.changed) return globFiles(base, when.changed).some((f) => !sameAsTemplate(f, path.relative(base, f).replace(/\\/g, "/"), job, tpl));
	if (when.all) return when.all.every((w) => met(job, w));
	return false;
}
// Ticks every open step whose file is now there. Returns the steps ticked.
export function check(jobId, sessionId) {
	const job = S.job(jobId);
	const ticked = [];
	for (const s of S.steps(jobId)) {
		if (s.state !== "open" || !s.done_when) continue;
		if (met(job, JSON.parse(s.done_when))) ticked.push(tick(jobId, s.pos, sessionId, "(file check)"));
	}
	return ticked;
}

// ---- ticking a milestone hands it the journal since the last one -----------------------------------------------
export function tick(jobId, which, sessionId, why) {
	const dir = sessionId ? S.session(sessionId)?.journal_dir : null;
	let log = null;
	if (dir) {
		const all = J.lines(dir);
		const from = S.mark(jobId, dir);
		const slice = all.slice(from);
		const topics = slice.filter((l) => /^\d+\. SLEEP /.test(l));
		log = [`journal ${dir}, lines ${from + 1}-${all.length}${why ? ` ${why}` : ""}`, ...(topics.length ? ["topics:", ...topics] : []), "actions:", ...slice].join("\n");
		S.setMark(jobId, dir, all.length);
	}
	return S.tick(jobId, which, log, sessionId);
}

// ---- a job's whole log when it is done ----------------------------------------------------------------------------
export function finish(jobId, sessionId) {
	S.move(jobId, "done", sessionId);
	const out = path.join(S.HOME, "logs", String(jobId));
	fs.mkdirSync(out, { recursive: true });
	for (const dir of S.journalDirsOf(jobId)) fs.writeFileSync(path.join(out, `${path.basename(dir)}.md`), J.snapshot(dir));
	S.event(jobId, "logs", `journal snapshots in ${out.replace(/\\/g, "/")}`, sessionId);
	writeCheckpoint(jobId, sessionId);
	return out;
}

// ---- the rolling checkpoint: where the whole job stands, rewritten as it moves --------------------------------------
const WINDOW = 25; // last actions kept
export function progress(jobId) {
	const st = S.steps(jobId);
	const done = st.filter((s) => s.state !== "open").length;
	return { done, total: st.length, current: st.find((s) => s.state === "open") };
}
export function checkpointText(jobId) {
	const job = S.job(jobId);
	if (!job) return null;
	const st = S.steps(jobId);
	const pr = progress(jobId);
	const sess = S.sessionsOf(jobId);
	const last = sess[sess.length - 1];
	const dir = last?.journal_dir;
	const pins = dir ? J.pins(dir) : [];
	const lines = dir ? J.lines(dir) : [];
	const topics = S.journalDirsOf(jobId).flatMap((d) => J.topics(d));
	const ev = S.events(jobId, 12);
	const cut = (s, n) => (s.length > n ? `${s.slice(0, n)} [...]` : s);
	return [
		`# Checkpoint: #${job.id} ${job.title}`,
		`updated ${S.now()} | project ${job.project_name} (${job.project_path}) | kind ${job.kind}${job.ref ? ` | ref ${job.ref}` : ""} | column ${job.col}`,
		"",
		`## Where it stands: ${pr.done}/${pr.total} milestones${pr.current ? `, now on ${pr.current.pos}. ${pr.current.title}` : ""}`,
		...st.map((s) => `- [${s.state === "done" ? "x" : s.state === "skipped" ? "-" : " "}] ${s.pos}. ${s.title}${s.key ? ` (${s.key})` : ""}${s.done_at ? `  - ${s.done_at}` : ""}`),
		"",
		`## Next: ${job.next || "(not written; set it with `board next " + job.id + " \"...\"`)"}`,
		"",
		...(pins.length
			? ["## What the user asked (latest chat's pins, cut short; whole in PINNED.md)", ...pins.map((p) => `- pin ${p.n}: ${cut(p.text.replace(/\s+/g, " "), 400)}${p.updates.map((u, k) => `\n  - ${p.n}.${k + 1} now: ${cut(u.replace(/\s+/g, " "), 1500)}`).join("")}`), ""]
			: []),
		...(topics.length ? ["## Topics closed", ...topics.slice(-10), ""] : []),
		`## Last ${Math.min(WINDOW, lines.length)} actions${dir ? ` (${dir}/JOURNAL.md)` : ""}`,
		...(lines.length ? lines.slice(-WINDOW) : ["(none journaled yet)"]),
		"",
		"## Board history",
		...ev.map((e) => `- ${e.at} ${e.kind}${e.text ? `: ${cut(e.text, 160)}` : ""}`),
		"",
		`Chats on this job: ${sess.length}${sess.length ? ` (${sess.map((s) => s.session_id.slice(0, 8)).join(", ")})` : ""}`,
		"Continue from this checkpoint: the open milestones above, the Next line, and the pins. Check files before redoing work.",
	].join("\n");
}
export function writeCheckpoint(jobId, sessionId) {
	const text = checkpointText(jobId);
	if (text) S.saveCheckpoint(jobId, text, sessionId);
	return text;
}

// ---- what a new chat sees ------------------------------------------------------------------------------------------
const bar = (p) => (p.total ? `${p.done}/${p.total}` : "-");
export function cardLine(j) {
	const p = progress(j.id);
	return `#${j.id} [${j.col}] ${j.title} (${bar(p)}${p.current ? `, on: ${p.current.title.slice(0, 50)}` : ""})${j.next ? ` next: ${j.next.slice(0, 80)}` : ""}`;
}
export function overview(cwd) {
	const here = S.project(cwd);
	const mine = S.jobs("j.project_id = ? and j.col != 'done'", here.id);
	const others = S.projects().filter((p) => p.id !== here.id).map((p) => {
		const open = S.jobs("j.project_id = ? and j.col != 'done'", p.id);
		return open.length ? `${p.name}: ${open.length} open (${open.slice(0, 3).map((j) => `#${j.id} ${j.title.slice(0, 40)}`).join("; ")})` : null;
	}).filter(Boolean);
	return { here, mine, others };
}
