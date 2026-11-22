// Background sync on a timer, with each system's own scheduler, while the user is logged in:
//   Windows  Task Scheduler, through bin/sync-hidden.vbs (no window flashes up)
//   macOS    a launchd agent (~/Library/LaunchAgents/com.agentic-task-journal.sync.plist)
//   Linux    a crontab line, marked so it can be found and taken out again
// plan() only says what would be done (tests read it); apply() does it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TASK = "AgenticTaskJournalSync";
const LABEL = "com.agentic-task-journal.sync";
const MARK = "# agentic-task-journal sync";

export function plan({ minutes = 15, platform = process.platform, node = process.execPath, root = ROOT, home = os.homedir() } = {}) {
	minutes = Math.max(1, Math.round(Number(minutes) || 15));
	// The scheduler's own system decides the separators (a plan for macOS made on Windows still needs forward slashes).
	const P = platform === "win32" ? path.win32 : path.posix;
	const board = P.join(root, "bin", "board.mjs");
	if (platform === "win32") {
		const vbs = P.join(root, "bin", "sync-hidden.vbs");
		return {
			kind: "Windows Task Scheduler",
			on: [["schtasks", ["/create", "/f", "/sc", "minute", "/mo", String(minutes), "/tn", TASK, "/tr", `wscript.exe //nologo "${vbs}" "${node}"`]]],
			off: [["schtasks", ["/delete", "/f", "/tn", TASK]]],
			status: ["schtasks", ["/query", "/tn", TASK]],
			files: [],
		};
	}
	if (platform === "darwin") {
		const plist = P.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${board}</string><string>sync</string></array>
  <key>StartInterval</key><integer>${minutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
		return {
			kind: "launchd",
			files: [{ path: plist, content: xml }],
			on: [["launchctl", ["unload", plist], { ignoreFailure: true }], ["launchctl", ["load", "-w", plist]]],
			off: [["launchctl", ["unload", "-w", plist], { ignoreFailure: true }]],
			remove: [plist],
			status: ["launchctl", ["list", LABEL]],
		};
	}
	// Linux and the rest: cron. Every N minutes below an hour, else every N hours.
	const when = minutes < 60 ? `*/${minutes} * * * *` : `0 */${Math.max(1, Math.round(minutes / 60))} * * *`;
	return { kind: "cron", cron: `${when} "${node}" "${board}" sync >/dev/null 2>&1 ${MARK}`, files: [], on: [], off: [], status: null };
}

const crontab = () => { const r = spawnSync("crontab", ["-l"], { encoding: "utf8" }); return r.status === 0 ? r.stdout : ""; };
const setCrontab = (text) => execFileSync("crontab", ["-"], { input: text, encoding: "utf8" });

export function apply(on, opts = {}) {
	const p = plan(opts);
	if (p.kind === "cron") {
		const kept = crontab().split("\n").filter((l) => l.trim() && !l.includes(MARK));
		setCrontab([...kept, ...(on ? [p.cron] : [])].join("\n") + "\n");
		return `${on ? "on" : "off"}: ${p.kind}${on ? ` (${p.cron.split(" sync")[0].split(" \"")[0]})` : ""}`;
	}
	if (on) for (const f of p.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
	for (const [cmd, args, o] of on ? p.on : p.off) {
		const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
		if (r.status !== 0 && !o?.ignoreFailure && !(!on && /cannot find|not found|No such/i.test(`${r.stderr}${r.stdout}`))) throw new Error(`${cmd} ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
	}
	if (!on) for (const f of p.remove ?? []) fs.rmSync(f, { force: true });
	return `${on ? "on" : "off"}: ${p.kind}${on ? `, every ${Math.max(1, Math.round(Number(opts.minutes) || 15))} min` : ""}`;
}

export function status(opts = {}) {
	const p = plan(opts);
	if (p.kind === "cron") return crontab().includes(MARK) ? `on (cron): ${crontab().split("\n").find((l) => l.includes(MARK))}` : "off (cron)";
	const r = spawnSync(p.status[0], p.status[1], { encoding: "utf8", windowsHide: true });
	return r.status === 0 ? `on (${p.kind})` : `off (${p.kind})`;
}
