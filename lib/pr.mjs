// A job's pull request, through the GitHub CLI (gh): open it with the report as its body, and follow it to the merge.
//   openPr   push the branch, `gh pr create` with the requirements + summary + work done as the body, keep the URL
//            on the card (external.github), tick the "pr" milestone, move the card to review
//   prStatus read the PR's state; MERGED ticks the "merged" milestone, and a job with its summary written is done
//   refreshAll  every open job's PR (sync runs it, so a merge on GitHub moves the card by itself)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as S from "./store.mjs";
import * as B from "./board.mjs";
import { report } from "./report.mjs";

const ENV = { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 120000, windowsHide: true }).trim();

// The repository the work is in: the job's ref when it is inside a git repo, else the project folder.
function repoDir(j) {
	const cands = [j.ref && path.resolve(j.project_path, j.ref), j.project_path].filter(Boolean);
	for (const c of cands) {
		try { return run("git", ["rev-parse", "--show-toplevel"], fs.statSync(c).isDirectory() ? c : path.dirname(c)); } catch {}
	}
	throw new Error(`no git repository at ${cands.join(" or ")}`);
}
const ext = (j) => JSON.parse(j.external || "{}");
function saveGithub(j, gh, sessionId) {
	S.setField(j.id, "external", JSON.stringify({ ...ext(j), github: { ...(ext(j).github ?? {}), ...gh } }), sessionId);
}

export function openPr(jobId, { base, draft = false, title, sessionId } = {}) {
	const j = S.job(jobId);
	if (!j) throw new Error(`no job ${jobId}`);
	const dir = repoDir(j);
	const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
	base ||= (() => { try { return run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], dir); } catch { return "main"; } })();
	if (branch === base || branch === "HEAD") throw new Error(`the repo at ${dir} is on ${branch}: commit the work on a branch first (git switch -c <branch>)`);
	// A PR this branch already has is taken, not opened twice; its body is brought up to date.
	let found = null;
	try { found = JSON.parse(run("gh", ["pr", "view", branch, "--json", "url,number,state"], dir)); } catch {}
	run("git", ["push", "-u", "origin", "HEAD"], dir);
	const body = path.join(os.tmpdir(), `atj-pr-${jobId}.md`);
	// The body is public: what the author wrote for the job, its milestones and the branch's own files.
	let files;
	try { files = run("git", ["diff", "--name-only", `origin/${base}...HEAD`], dir).split("\n").filter(Boolean); } catch {}
	fs.writeFileSync(body, `${report(jobId, { public: true, files })}\n\n_Tracked by Agentic Task Journal, job #${jobId}._\n`);
	if (found) run("gh", ["pr", "edit", found.url, "--body-file", body], dir);
	else {
		const url = run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title || j.title, "--body-file", body, ...(draft ? ["--draft"] : [])], dir).split("\n").pop();
		found = { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1]), state: "OPEN" };
	}
	saveGithub(j, { ...found, branch, base, repo: dir.replace(/\\/g, "/") }, sessionId);
	S.event(jobId, "pr", found.url, sessionId);
	B.check(jobId, sessionId);
	if (!["review", "done"].includes(S.job(jobId).col)) S.move(jobId, "review", sessionId);
	B.writeCheckpoint(jobId, sessionId);
	return found;
}

export function prStatus(jobId, sessionId) {
	const j = S.job(jobId);
	const gh = ext(j).github;
	if (!gh?.url) throw new Error(`job ${jobId} has no pull request (board pr ${jobId})`);
	const st = JSON.parse(run("gh", ["pr", "view", gh.url, "--json", "state,mergedAt,reviewDecision,url,number"], gh.repo || j.project_path));
	const changed = st.state !== gh.state || st.reviewDecision !== gh.reviewDecision;
	saveGithub(j, { state: st.state, mergedAt: st.mergedAt, reviewDecision: st.reviewDecision }, sessionId);
	if (changed) S.event(jobId, "pr-state", `${st.state}${st.reviewDecision ? `, ${st.reviewDecision}` : ""}`, sessionId);
	B.check(jobId, sessionId);
	if (st.state === "MERGED" && S.job(jobId).summary && S.job(jobId).col !== "done") B.finish(jobId, sessionId);
	B.writeCheckpoint(jobId, sessionId);
	return st;
}

export function refreshAll() {
	const out = [];
	for (const j of S.jobs("j.col != 'done'")) {
		const gh = ext(j).github;
		if (!gh?.url || gh.state === "MERGED" || gh.state === "CLOSED") continue;
		try { const st = prStatus(j.id, null); if (st.state !== gh.state) out.push(`#${j.id} PR ${st.state.toLowerCase()}`); } catch {}
	}
	return out;
}
