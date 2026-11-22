#!/usr/bin/env node
// board: the central task board for every project, kept local (data/board.db) and synced through git.
//
//   board                                  overview: this project's open jobs, then every other project
//   board new "<title>" [--kind K] [--ref output/slug] [--col doing]
//                                          a new job (kinds: templates/*.json; the plan comes from the kind) and
//                                          this chat is attached to it
//   board attach <id>                      this chat works on job <id> (a draft never needs merging: just attach)
//   board resume <id>                      attach + print the job's checkpoint: continue from it, no research
//   board show <id>                        the card: milestones, next, history, logs
//   board tick <id> <step> | untick | skip  a milestone (by number, key or words) done; it gets the journal since the last one
//   board step <id> "<title>"              add a step to the plan
//   board next <id> "<what comes next>"    the line a later chat starts from
//   board move <id> <column>               backlog | planned | doing | blocked | review | done
//   board done <id>                        Done, with every chat's AgentJournal pins + journal kept as the job's log
//   board check [<id>]                     tick the milestones whose files are now there
//   board note <id> "<line>"               a line in the card's history
//   board req <id> "<requirement>"         one requirement, as it stands (the report lists them, numbered)
//   board summary <id> "<text>"            what was done, why, and how it was verified (top of the report)
//   board report <id> [--write]            the end-of-task report: summary, requirements (written + the user's own
//                                          words with how each stands now), decisions, work done, files changed,
//                                          verification, the PR, what is still open
//   board pr <id> [--base main] [--draft] [--title "..."]
//                                          push the branch and open a pull request with the report as its body (gh)
//   board pr <id> --status                 follow the PR: merged ticks "merged"; with a summary written, the job is done
//   board list [--all]                     every job (open only unless --all)
//   board checkpoint <id>                  rewrite and print the checkpoint
//   board sync                             export cards to data/, apply phone edits, git commit, push if a remote is set
//   board serve [--port 7420] [--host 127.0.0.1]   the kanban page
//   board kinds                            the job kinds and their milestones
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../lib/store.mjs";
import * as B from "../lib/board.mjs";
import * as J from "../lib/journal.mjs";

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		const k = argv[i].slice(2);
		flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
	} else args.push(argv[i]);
}
const [cmd, ...rest] = args;

// The project is the folder Claude Code was opened on, else the nearest git or .agentjournal folder above here.
function chatDir() {
	if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
	for (let d = process.cwd(); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, ".git")) || fs.existsSync(path.join(d, ".agentjournal"))) return d;
		if (path.dirname(d) === d) return process.cwd();
	}
}
// --project files a job under another project; the chat (and its journal) stays where it runs.
const projectDir = () => (flags.project ? path.resolve(flags.project) : chatDir());
const sid = process.env.CLAUDE_CODE_SESSION_ID || null;
const here = projectDir();
function me() {
	if (!sid) return null;
	return S.seeSession(sid, { project_id: S.project(chatDir()).id, journal_dir: J.journalDir(chatDir(), sid) ?? undefined });
}
const die = (m) => { console.error(`board: ${m}`); process.exit(2); };
const needJob = (id) => S.job(id) ?? die(`no job ${id ?? "(give a job number)"}`);
const out = (s) => console.log(s);

function show(j) {
	const p = B.progress(j.id);
	out(`#${j.id} ${j.title}\n  ${j.project_name} | ${j.kind}${j.ref ? ` | ${j.ref}` : ""} | ${j.col} | ${p.done}/${p.total} milestones`);
	if (j.next) out(`  next: ${j.next}`);
	for (const s of S.steps(j.id)) out(`  [${s.state === "done" ? "x" : s.state === "skipped" ? "-" : " "}] ${s.pos}. ${s.title}${s.key ? ` (${s.key})` : ""}${s.log ? `  [log: ${s.log.split("\n").length - 1} lines]` : ""}`);
	out("  history:");
	for (const e of S.events(j.id, 15)) out(`    ${e.at} ${e.kind}${e.text ? `: ${e.text.slice(0, 140)}` : ""}`);
	const logs = path.join(S.HOME, "logs", String(j.id));
	if (fs.existsSync(logs)) out(`  logs: ${logs.replace(/\\/g, "/")}`);
}

try {
	switch (cmd) {
		case undefined:
		case "overview": {
			me();
			const o = B.overview(here);
			out(`Board for ${o.here.name} (${o.here.path}):`);
			out(o.mine.length ? o.mine.map((j) => `  ${B.cardLine(j)}`).join("\n") : "  (no open jobs)");
			if (o.others.length) out(`Other projects:\n${o.others.map((l) => `  ${l}`).join("\n")}`);
			break;
		}
		case "kinds":
			for (const t of B.templates(here)) out(`${t.kind}: ${t.description}\n${t.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.done_when ? `  [auto: ${JSON.stringify(s.done_when)}]` : ""}`).join("\n")}`);
			break;
		case "new": {
			const title = rest.join(" ").trim() || die('usage: board new "<title>" [--kind K] [--ref path] [--col doing]');
			const kind = flags.kind || "generic";
			const tpl = B.template(kind, here) ?? die(`no kind "${kind}" (board kinds)`);
			const s = me();
			const j = S.newJob({ projectId: S.project(here).id, title, kind, ref: flags.ref ? String(flags.ref).replace(/\\/g, "/") : null, col: flags.col || "doing", steps: tpl.steps }, sid);
			if (s) S.attach(sid, j.id);
			B.check(j.id, sid);
			B.writeCheckpoint(j.id, sid);
			show(S.job(j.id));
			break;
		}
		case "attach":
		case "resume": {
			const j = needJob(rest[0]);
			if (me()) S.attach(sid, j.id);
			if (j.col === "planned" || j.col === "backlog") S.move(j.id, "doing", sid);
			B.check(j.id, sid);
			const text = B.writeCheckpoint(j.id, sid);
			out(cmd === "resume" ? text : `attached to #${j.id} ${j.title}`);
			break;
		}
		case "show":
			show(needJob(rest[0]));
			break;
		case "tick":
		case "untick":
		case "skip": {
			const j = needJob(rest[0]);
			const which = rest.slice(1).join(" ") || die(`usage: board ${cmd} <id> <step number, key or words>`);
			me();
			const s = cmd === "tick" ? B.tick(j.id, which, sid) : S.tick(j.id, which, null, sid, cmd === "skip" ? "skipped" : "open");
			B.writeCheckpoint(j.id, sid);
			const p = B.progress(j.id);
			out(`#${j.id} ${s.pos}. ${s.title}: ${cmd === "tick" ? "done" : cmd === "skip" ? "skipped" : "open again"} (${p.done}/${p.total}${p.current ? `, next milestone: ${p.current.title}` : ", all milestones done"})`);
			break;
		}
		case "step": {
			const j = needJob(rest[0]);
			S.addStep(j.id, rest.slice(1).join(" ") || die('usage: board step <id> "<title>"'), sid);
			B.writeCheckpoint(j.id, sid);
			out(`#${j.id}: step added`);
			break;
		}
		case "next": {
			const j = needJob(rest[0]);
			S.setField(j.id, "next", rest.slice(1).join(" "), sid);
			B.writeCheckpoint(j.id, sid);
			out(`#${j.id} next: ${rest.slice(1).join(" ")}`);
			break;
		}
		case "move": {
			const j = needJob(rest[0]);
			if (rest[1] === "done") out(`#${j.id} done; logs in ${B.finish(j.id, sid)}`);
			else { S.move(j.id, rest[1], sid); B.writeCheckpoint(j.id, sid); out(`#${j.id} -> ${rest[1]}`); }
			break;
		}
		case "done": {
			const j = needJob(rest[0]);
			me();
			const logs = B.finish(j.id, sid).replace(/\\/g, "/");
			const { report } = await import("../lib/report.mjs");
			out(report(j.id));
			out(`\n#${j.id} done. Report: ${S.HOME.replace(/\\/g, "/")}/reports/${j.id}.md; every chat's pins + journal: ${logs}`);
			if (!S.job(j.id).summary) out(`(no summary written: \`board summary ${j.id} "..."\`, then \`board report ${j.id} --write\`)`);
			break;
		}
		case "check": {
			const list = rest[0] ? [needJob(rest[0])] : S.jobs("j.col != 'done'");
			for (const j of list) {
				const t = B.check(j.id, sid);
				if (t.length) { B.writeCheckpoint(j.id, sid); out(`#${j.id}: ticked ${t.map((s) => s.key || s.pos).join(", ")}`); }
			}
			out("checked");
			break;
		}
		case "note": {
			const j = needJob(rest[0]);
			S.event(j.id, "note", rest.slice(1).join(" "), sid);
			B.writeCheckpoint(j.id, sid);
			out(`#${j.id}: noted`);
			break;
		}
		case "req": {
			const j = needJob(rest[0]);
			const text = rest.slice(1).join(" ").trim() || die('usage: board req <id> "<one requirement>"');
			me();
			S.event(j.id, "requirement", text, sid);
			B.writeCheckpoint(j.id, sid);
			out(`#${j.id}: requirement ${S.events(j.id, 100000).filter((e) => e.kind === "requirement").length} written`);
			break;
		}
		case "summary": {
			const j = needJob(rest[0]);
			S.setField(j.id, "summary", rest.slice(1).join(" ").trim() || die('usage: board summary <id> "<text>"'), sid);
			B.check(j.id, sid);
			B.writeCheckpoint(j.id, sid);
			out(`#${j.id}: summary written`);
			break;
		}
		case "report": {
			const j = needJob(rest[0]);
			const { report, writeReport } = await import("../lib/report.mjs");
			if (flags.write) { const r = writeReport(j.id); out(r.text); out(`\n(written to ${r.file})`); } else out(report(j.id));
			break;
		}
		case "pr": {
			const j = needJob(rest[0]);
			me();
			const P = await import("../lib/pr.mjs");
			if (flags.status) { const st = P.prStatus(j.id, sid); out(`#${j.id} PR ${st.url}: ${st.state}${st.reviewDecision ? `, ${st.reviewDecision}` : ""}${S.job(j.id).col === "done" ? " - job done" : ""}`); }
			else { const pr = P.openPr(j.id, { base: flags.base, draft: !!flags.draft, title: flags.title, sessionId: sid }); out(`#${j.id} PR ${pr.url} (${pr.state})`); }
			break;
		}
		case "list":
			for (const j of S.jobs(flags.all ? "1=1" : "j.col != 'done'")) out(`${j.project_name.padEnd(18)} ${B.cardLine(j)}`);
			break;
		case "checkpoint":
			out(B.writeCheckpoint(needJob(rest[0]).id, sid));
			break;
		case "sync": {
			const { sync } = await import("../lib/sync.mjs");
			out(sync({ push: !flags["no-push"] }));
			break;
		}
		case "serve": {
			const { serve } = await import("../lib/server.mjs");
			serve({ port: Number(flags.port || 7420), host: flags.host || "127.0.0.1" });
			break;
		}
		default: {
			const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
			const help = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
			const asked = cmd === "help" || cmd === "--help" || cmd === "-h";
			if (!asked) console.error(`board: there is no command "${cmd}".`);
			(asked ? console.log : console.error)(help);
			process.exit(asked ? 0 : 2);
		}
	}
} catch (e) {
	die(e.message);
}
