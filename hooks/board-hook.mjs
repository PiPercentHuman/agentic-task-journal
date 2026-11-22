#!/usr/bin/env node
// The board's Claude Code hooks. Written by code, so the board does not depend on the model remembering:
//   start   SessionStart   a new chat sees the board (this project's open jobs + the other projects); a chat that
//                          continues a job (resume, compact, the /clear after an AgentJournal sleep) gets its checkpoint
//   prompt  UserPromptSubmit  the chat is recorded; the first message of a chat with no job is reminded of the board
//   tool    PostToolUse    the rolling checkpoint of the chat's job is rewritten (where the whole job stands, the last
//                          actions); a TodoWrite plan on a generic job becomes its steps
//   stop    Stop           milestone files are checked and the checkpoint rewritten at the end of every turn; once a
//                          remote is set, `board sync` runs in the background (at most every 5 minutes)
//   allow   PreToolUse     the board's own commands run without a permission prompt (not serve, which runs until stopped)
// Never blocks the session: any error is swallowed.
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "board.mjs").replace(/\\/g, "/");
const BOARD = `node "${CLI}"`;
const say = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

async function main(action, ev) {
	if (action === "allow") {
		// Only the board call alone: plain arguments, no $ or backtick, nothing chained.
		const cmd = String(ev.tool_input?.command ?? "").trim();
		const m = cmd.match(/^(?:&\s*)?(?:node(?:\.exe)?\s+)?("[^"]*board(?:\.mjs)?"|'[^']*board(?:\.mjs)?'|[^\s;&|]*[\\/]board\.mjs)(?:\s+([\s\S]*))?$/);
		if (!m) return;
		const rest = (m[2] ?? "").trim();
		const sub = rest.split(/\s+/)[0] || "overview";
		if (sub === "serve") return; // runs until stopped; sync is allowed (user, 2026-11-22: sync with no approvals)
		if (!/^(?:[\w#.\-/:]+|"(?:[^"\\$`]|\\[^$`])*"|'[^']*'|\s+)*$/.test(rest)) return;
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `Task board: ${sub}` } }));
		return;
	}
	const S = await import("../lib/store.mjs");
	const B = await import("../lib/board.mjs");
	const J = await import("../lib/journal.mjs");
	const sid = String(ev.session_id ?? "");
	if (!sid) return;
	const proj = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
	const project = S.project(proj);
	const dir = J.journalDir(proj, sid);
	let s = S.seeSession(sid, { project_id: project.id, journal_dir: dir ?? undefined });
	// A chat that writes to a journal folder another chat already worked a job in (an AgentJournal /clear) continues that job.
	if (!s.job_id) {
		const j = S.jobOfJournal(dir);
		if (j) { S.attach(sid, j); s = S.session(sid); }
	}
	const job = s.job_id ? S.job(s.job_id) : null;

	if (action === "start") {
		const source = ev.source || "startup";
		if (job && source !== "startup") {
			const p = B.progress(job.id);
			const text = B.writeCheckpoint(job.id, sid);
			say("SessionStart", `TASK BOARD: this chat continues job #${job.id} "${job.title}" (${p.done}/${p.total} milestones). Its checkpoint:\n\n${text}\n\nTick a milestone when it is done: \`${BOARD} tick ${job.id} <step>\`; before you stop, write where it stands: \`${BOARD} next ${job.id} "<what comes next>"\`.`);
			return;
		}
		const o = B.overview(proj);
		const lines = [
			`TASK BOARD (central, every project; ${BOARD}). This project, ${o.here.name}:`,
			...(o.mine.length ? o.mine.map((j) => `  ${B.cardLine(j)}`) : ["  (no open jobs)"]),
			...(o.others.length ? ["Other projects:", ...o.others.map((l) => `  ${l}`)] : []),
			`When the user's request continues one of these jobs, run \`${BOARD} resume <id>\` and continue from its checkpoint without re-researching. ` +
				`When it starts a real job (more than a quick question), run \`${BOARD} new "<title>" --kind <kind> [--ref <its folder>]\` ` +
				`(kinds: ${B.templates().map((t) => t.kind).join(", ")}; a new video is full3d-video with --ref output/<slug>). ` +
				`Then: \`${BOARD} tick <id> <step>\` as each milestone finishes, \`${BOARD} next <id> "<line>"\` before you stop, \`${BOARD} done <id>\` at the end.`,
		];
		say("SessionStart", lines.join("\n"));
		return;
	}
	if (action === "prompt") {
		const first = !s.first_prompt;
		if (first) S.seeSession(sid, { first_prompt: String(ev.prompt ?? "").slice(0, 500) });
		if (job) S.event(job.id, "message", String(ev.prompt ?? "").replace(/\s+/g, " ").slice(0, 200), sid);
		else if (first) say("UserPromptSubmit", `Task board: this chat has no job yet. If this message starts or continues a job, \`${BOARD} new ...\` or \`${BOARD} resume <id>\` (\`${BOARD}\` lists them).`);
		return;
	}
	if (action === "tool") {
		if (!job) return;
		const input = ev.tool_input ?? {};
		if (ev.tool_name === "TodoWrite" && job.kind === "generic" && Array.isArray(input.todos)) {
			const have = S.steps(job.id);
			for (const t of input.todos) {
				const title = String(t.content ?? t.subject ?? "").trim();
				if (!title) continue;
				const st = have.find((x) => x.title === title);
				if (!st) S.addStep(job.id, title, sid);
				if (t.status === "completed" && st?.state !== "done") B.tick(job.id, (st ?? S.findStep(job.id, title)).pos, sid, "(todo completed)");
			}
		}
		B.writeCheckpoint(job.id, sid);
		return;
	}
	if (action === "stop") {
		(await import("../lib/sync.mjs")).syncSoon(CLI);
		if (!job) return;
		if (job.ref) B.check(job.id, sid);
		B.writeCheckpoint(job.id, sid);
	}
}

let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", async () => {
	try {
		await main(process.argv[2], JSON.parse(raw || "{}"));
	} catch (e) {
		if (process.env.TASKBOARD_DEBUG) console.error(e);
	}
});
