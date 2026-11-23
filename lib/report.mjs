// The end-of-task report: the requirements (as written for the job, and in the user's own words with how each
// stands now), the summary, the decisions, the work done, the files changed, how it was verified, the pull request
// and what is still open. Built from the board and the AgentJournal notes, so it says what happened, not what a
// model remembers. `board report <id>` prints it; `board done` and `board pr` write it.
import fs from "node:fs";
import path from "node:path";
import * as S from "./store.mjs";
import * as J from "./journal.mjs";

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)} [...]` : s);
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const TEST = /\b(test|tests|pytest|jest|vitest|mocha|node --test|go test|cargo test|npm (run )?test|pnpm test|yarn test|tox|ctest|check|lint|tsc)\b/i;

function parse(line) {
	const m = line.match(/^(\d+)\. (\S+) ([\s\S]*)$/);
	return m ? { n: Number(m[1]), tool: m[2], text: m[3] } : null;
}

// opts.public (a pull request body): only what the job's author wrote for it (summary, requirements), the milestones,
// the branch's files (opts.files) and what is still open. Nothing read from the journal: the pins, the notes, the
// topics and the commands stay in the local report, with the local paths.
export function report(jobId, opts = {}) {
	const j = S.job(jobId);
	if (!j) return null;
	const steps = S.steps(jobId);
	const dirs = S.journalDirsOf(jobId);
	const events = S.events(jobId, 100000);
	const pr = JSON.parse(j.external || "{}").github;
	const reqs = events.filter((e) => e.kind === "requirement");
	const notes = events.filter((e) => e.kind === "note");
	const lines = S.journalStarts(jobId).flatMap(({ dir, start }) => J.lines(dir).slice(start).map(parse).filter(Boolean));
	const journaled = [...new Set(lines.filter((l) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(l.tool)).map((l) => l.text.replace(/\\/g, "/").replace(/ - FAILED$/, "")))];
	const files = opts.files ?? journaled;
	const SECRET = /token|passw|secret|api[_-]?key|bearer|authorization/i;
	const checks = lines.filter((l) => /^(Bash|PowerShell)$/.test(l.tool) && TEST.test(l.text) && !(opts.public && SECRET.test(l.text))).map((l) => `${l.text}`);
	// An UPDATE restates the user's instruction in full: like the pins, it stays out of a public report.
	const decisions = lines.filter((l) => (opts.public ? /^NOTE$/ : /^(NOTE|UPDATE)$/).test(l.tool)).map((l) => `${l.tool === "UPDATE" ? "Changed: " : ""}${l.text}`);
	const topics = lines.filter((l) => l.tool === "SLEEP").map((l) => l.text);
	const done = steps.filter((s) => s.state === "done");
	const open = steps.filter((s) => s.state === "open");
	const skipped = steps.filter((s) => s.state === "skipped");

	const out = [
		`# ${j.title} (#${j.id})`,
		"",
		`${j.project_name} · ${j.kind}${j.ref ? ` · ${j.ref}` : ""} · opened ${j.created}${j.done_at ? ` · done ${j.done_at}` : ` · ${j.col}`}${pr?.url ? ` · PR ${pr.url}${pr.state ? ` (${pr.state.toLowerCase()})` : ""}` : ""}`,
		"",
		"## Summary",
		"",
		j.summary || `(not written yet: \`board summary ${j.id} "<what was done, why, and how it was verified>"\`)`,
		"",
		"## Requirements",
		"",
	];
	if (reqs.length) out.push(...reqs.map((r, i) => `${i + 1}. ${r.text}`), "");
	else out.push(`(none written for this job yet: \`board req ${j.id} "<one requirement>"\`${opts.public ? "" : "; the user's words are below"})`, "");
	for (const d of opts.public ? [] : dirs) {
		const pins = J.pins(d);
		if (!pins.length) continue;
		out.push(`### In the user's words (chat ${path.basename(d).slice(0, 8)})`, "");
		for (const p of pins) {
			if (p.updates.length) {
				out.push(`- **Pin ${p.n}, as it stands now:** ${cut(flat(p.updates[p.updates.length - 1]), 1500)}`);
				out.push(`  - first said: ${cut(flat(p.text), 600)}`);
			} else out.push(`- **Pin ${p.n}:** ${cut(flat(p.text), 1200)}`);
		}
		out.push("");
	}
	if (!opts.public) out.push("## Decisions", "", ...(decisions.length || notes.length ? [...decisions, ...notes.map((n) => n.text)].map((d) => `- ${cut(flat(d), 600)}`) : ["(none recorded)"]), "");
	out.push("## Work done", "");
	out.push(...(done.length ? done.map((s) => `- [x] ${s.title}${s.done_at ? ` (${s.done_at})` : ""}`) : ["(no milestone ticked)"]));
	if (skipped.length) out.push(...skipped.map((s) => `- [-] ${s.title} (skipped)`));
	if (topics.length && !opts.public) out.push("", "Topics closed, in order:", ...topics.map((t) => `- ${cut(flat(t), 400)}`));
	out.push("", "## Files changed", "", ...(files.length ? files.map((f) => `- ${f}`) : ["(none journaled)"]), "");
	if (!opts.public) out.push("## Verification", "", ...(checks.length ? checks.slice(-20).map((c) => `- \`${cut(flat(c), 200)}\``) : ["(no test or check command journaled)"]), "");
	if (pr?.url) out.push("## Pull request", "", `- ${pr.url}${pr.number ? ` (#${pr.number})` : ""}${pr.state ? `, ${pr.state.toLowerCase()}` : ""}${pr.mergedAt ? `, merged ${pr.mergedAt}` : ""}`, "");
	// In a PR body the PR's own milestones are not "open": the body is the PR.
	const stillOpen = opts.public ? open.filter((s) => !/"pr"/.test(s.done_when || "") && s.key !== "review") : open;
	out.push("## Still open", "", ...(stillOpen.length ? stillOpen.map((s) => `- [ ] ${s.title}`) : ["(nothing)"]), "");
	if (!opts.public) out.push(`---\n${S.sessionsOf(jobId).length} chat(s) worked on this job; their pins and journals: ${dirs.length ? dirs.join(", ") : "(none)"}`);
	return out.join("\n");
}

export function writeReport(jobId) {
	const text = report(jobId);
	if (!text) return null;
	const dir = path.join(S.HOME, "reports");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${jobId}.md`);
	fs.writeFileSync(file, text);
	return { text, file: file.replace(/\\/g, "/") };
}
