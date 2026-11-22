// The board's store: one SQLite file for every project (node:sqlite, built into Node 22.5+, no dependencies).
// WAL mode, so several chat windows can write at once. Everything that happens to a card is also an event, which is
// what the history, the export and (later) the ticket-system adapters read.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as J from "./journal.mjs";

process.removeAllListeners("warning"); // node:sqlite prints an ExperimentalWarning; hooks must stay quiet
const { DatabaseSync } = await import("node:sqlite");

// The board lives outside every project and outside this code: ATJ_HOME, else ~/.agentic-task-journal.
export const HOME = process.env.ATJ_HOME || process.env.TASKBOARD_HOME || path.join(os.homedir(), ".agentic-task-journal");
export const COLUMNS = ["backlog", "planned", "doing", "blocked", "review", "done"];

const SCHEMA = `
create table if not exists projects (id integer primary key, path text unique not null, name text not null, created text not null);
create table if not exists jobs (
  id integer primary key, project_id integer not null references projects(id), title text not null,
  kind text not null default 'generic', ref text, col text not null default 'planned', priority integer not null default 2,
  labels text not null default '[]', external text not null default '{}', next text,
  created text not null, updated text not null, done_at text);
create table if not exists steps (
  id integer primary key, job_id integer not null references jobs(id), pos integer not null, key text, title text not null,
  done_when text, state text not null default 'open', done_at text, log text);
create table if not exists sessions (
  session_id text primary key, job_id integer references jobs(id), project_id integer references projects(id),
  journal_dir text, first_prompt text, started text not null, last_seen text not null);
create table if not exists events (
  id integer primary key, job_id integer, at text not null, kind text not null, session_id text, text text);
create table if not exists marks (job_id integer not null, journal_dir text not null, line integer not null, primary key (job_id, journal_dir));
-- every chat that ever worked a job (sessions.job_id is only the job a chat is on now)
create table if not exists links (job_id integer not null, session_id text not null, start_line integer not null default 0, primary key (job_id, session_id));
create table if not exists checkpoints (job_id integer primary key, at text not null, session_id text, text text not null);
`;

export const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

let db;
export function open() {
	if (db) return db;
	fs.mkdirSync(HOME, { recursive: true });
	db = new DatabaseSync(path.join(HOME, "board.db"));
	db.exec("pragma journal_mode=wal; pragma busy_timeout=4000; pragma foreign_keys=on;");
	db.exec(SCHEMA);
	// Columns added after 0.1 (an older board.db gets them here).
	for (const col of ["summary text"]) { try { db.exec(`alter table jobs add column ${col}`); } catch {} }
	try { db.exec("alter table links add column start_line integer not null default 0"); } catch {}
	db.exec("insert or ignore into links (job_id, session_id) select job_id, session_id from sessions where job_id is not null");
	return db;
}
const q = (sql) => open().prepare(sql);

// A project is a folder. Its name is the folder's name unless given.
export function project(dir, name) {
	const p = path.resolve(dir).replace(/\\/g, "/").toLowerCase();
	const got = q("select * from projects where path = ?").get(p);
	if (got) return got;
	q("insert into projects (path, name, created) values (?, ?, ?)").run(p, name || path.basename(p), now());
	return q("select * from projects where path = ?").get(p);
}
export const projects = () => q("select * from projects order by name").all();

export function event(jobId, kind, text, session) {
	q("insert into events (job_id, at, kind, session_id, text) values (?, ?, ?, ?, ?)").run(jobId ?? null, now(), kind, session ?? null, text ?? null);
	if (jobId) q("update jobs set updated = ? where id = ?").run(now(), jobId);
}

export function newJob({ projectId, title, kind = "generic", ref = null, col = "planned", steps = [] }, session) {
	const t = now();
	const r = q("insert into jobs (project_id, title, kind, ref, col, created, updated) values (?, ?, ?, ?, ?, ?, ?)").run(projectId, title, kind, ref, col, t, t);
	const id = Number(r.lastInsertRowid);
	steps.forEach((s, i) => q("insert into steps (job_id, pos, key, title, done_when) values (?, ?, ?, ?, ?)").run(id, i + 1, s.key ?? null, s.title, s.done_when ? JSON.stringify(s.done_when) : null));
	event(id, "created", `${kind}: ${title}${steps.length ? ` (${steps.length} steps)` : ""}`, session);
	return job(id);
}
export const job = (id) => q("select j.*, p.path as project_path, p.name as project_name from jobs j join projects p on p.id = j.project_id where j.id = ?").get(Number(id));
export const jobs = (where = "1=1", ...args) =>
	q(`select j.*, p.path as project_path, p.name as project_name from jobs j join projects p on p.id = j.project_id where ${where} order by j.col = 'done', j.priority, j.updated desc`).all(...args);
export const steps = (jobId) => q("select * from steps where job_id = ? order by pos").all(Number(jobId));
export const events = (jobId, limit = 50) => q("select * from events where job_id = ? order by id desc limit ?").all(Number(jobId), limit).reverse();

export function move(id, col, session) {
	if (!COLUMNS.includes(col)) throw new Error(`column must be one of ${COLUMNS.join(", ")}`);
	q("update jobs set col = ?, done_at = ? where id = ?").run(col, col === "done" ? now() : null, Number(id));
	event(id, "moved", col, session);
}
export function setField(id, field, value, session) {
	if (!["title", "next", "priority", "labels", "external", "ref", "kind", "summary"].includes(field)) throw new Error(`no field ${field}`);
	q(`update jobs set ${field} = ? where id = ?`).run(value, Number(id));
	event(id, field, String(value), session);
}
export function addStep(jobId, title, session) {
	const pos = (q("select max(pos) m from steps where job_id = ?").get(Number(jobId)).m ?? 0) + 1;
	q("insert into steps (job_id, pos, title) values (?, ?, ?)").run(Number(jobId), pos, title);
	event(jobId, "step-added", title, session);
}
// A step is named by its position or its key ("narration").
export function findStep(jobId, which) {
	const all = steps(jobId);
	return all.find((s) => String(s.pos) === String(which) || s.key === which) ?? all.find((s) => s.title.toLowerCase().includes(String(which).toLowerCase()));
}
export function tick(jobId, which, log, session, state = "done") {
	const s = findStep(jobId, which);
	if (!s) throw new Error(`job ${jobId} has no step "${which}"`);
	if (s.state === state) return s;
	q("update steps set state = ?, done_at = ?, log = coalesce(?, log) where id = ?").run(state, state === "done" ? now() : null, log ?? null, s.id);
	event(jobId, state === "done" ? "ticked" : `step-${state}`, `${s.pos}. ${s.title}`, session);
	return { ...s, state };
}

// Sessions: which chat works on which job. One job, many chats.
export function seeSession(sessionId, fields = {}) {
	const t = now();
	const got = q("select * from sessions where session_id = ?").get(sessionId);
	if (!got) q("insert into sessions (session_id, started, last_seen) values (?, ?, ?)").run(sessionId, t, t);
	const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
	q(`update sessions set last_seen = ?${sets.map(([k]) => `, ${k} = ?`).join("")} where session_id = ?`).run(t, ...sets.map(([, v]) => v), sessionId);
	return q("select * from sessions where session_id = ?").get(sessionId);
}
export const session = (id) => q("select * from sessions where session_id = ?").get(id);
export const sessionsOf = (jobId) => q("select s.* from links l join sessions s on s.session_id = l.session_id where l.job_id = ? order by s.last_seen").all(Number(jobId));
// After an AgentJournal /clear the new session writes to the old journal folder: the job follows the folder.
export const jobOfJournal = (dir) => (dir ? q("select job_id from sessions where journal_dir = ? and job_id is not null order by last_seen desc").get(dir)?.job_id : undefined);
export function attach(sessionId, jobId) {
	seeSession(sessionId, { job_id: Number(jobId) });
	// Where in the chat's journal this job began: a chat that worked on something else first keeps that out of the job.
	const dir = session(sessionId)?.journal_dir;
	q("insert or ignore into links (job_id, session_id, start_line) values (?, ?, ?)").run(Number(jobId), sessionId, dir ? J.lines(dir).length : 0);
	event(jobId, "attached", sessionId, sessionId);
}

export function saveCheckpoint(jobId, text, sessionId) {
	q("insert into checkpoints (job_id, at, session_id, text) values (?, ?, ?, ?) on conflict(job_id) do update set at = excluded.at, session_id = excluded.session_id, text = excluded.text").run(Number(jobId), now(), sessionId ?? null, text);
	const dir = path.join(HOME, "checkpoints");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${jobId}.md`), text);
}
export const checkpoint = (jobId) => q("select * from checkpoints where job_id = ?").get(Number(jobId));

// How far into a journal folder this job's logs have already been handed to a step.
export const mark = (jobId, dir) => q("select line from marks where job_id = ? and journal_dir = ?").get(Number(jobId), dir)?.line ?? 0;
export const setMark = (jobId, dir, line) =>
	q("insert into marks (job_id, journal_dir, line) values (?, ?, ?) on conflict(job_id, journal_dir) do update set line = excluded.line").run(Number(jobId), dir, line);
// Each journal folder the job was worked in, and the journal line it began at there.
export const journalStarts = (jobId) =>
	q("select s.journal_dir as dir, min(l.start_line) as start from links l join sessions s on s.session_id = l.session_id where l.job_id = ? and s.journal_dir is not null group by s.journal_dir").all(Number(jobId));
export const journalDirsOf = (jobId) => q("select distinct s.journal_dir from links l join sessions s on s.session_id = l.session_id where l.job_id = ? and s.journal_dir is not null").all(Number(jobId)).map((r) => r.journal_dir);

export const userName = () => os.userInfo().username;
