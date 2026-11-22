// `board serve`: the kanban page and a small JSON API over the same store the chats write.
//   GET  /                      web/index.html
//   GET  /api/board             every card (sync.board())
//   GET  /api/checkpoint/<id>   the job's checkpoint (Markdown)
//   POST /api/op                { op, job, ... } - the same edits the phone inbox carries (sync.apply)
// Binds to 127.0.0.1 unless --host is given (e.g. the Tailscale address); there is no login, so never 0.0.0.0 on an open network.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./store.mjs";
import * as B from "./board.mjs";
import { board, apply } from "./sync.mjs";

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "index.html");

export function serve({ port = 7420, host = "127.0.0.1" } = {}) {
	const send = (res, code, body, type = "application/json") => {
		res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
		res.end(type === "application/json" ? JSON.stringify(body) : body);
	};
	http.createServer((req, res) => {
		try {
			const url = new URL(req.url, "http://x");
			if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(res, 200, fs.readFileSync(PAGE, "utf8"), "text/html");
			if (req.method === "GET" && url.pathname === "/api/board") return send(res, 200, board());
			const cp = url.pathname.match(/^\/api\/checkpoint\/(\d+)$/);
			if (req.method === "GET" && cp) return send(res, 200, S.checkpoint(cp[1])?.text ?? B.checkpointText(cp[1]) ?? "", "text/markdown");
			if (req.method === "POST" && url.pathname === "/api/op") {
				let raw = "";
				req.on("data", (d) => (raw += d)).on("end", () => {
					try { apply(JSON.parse(raw), "web"); send(res, 200, { ok: true }); } catch (e) { send(res, 400, { error: e.message }); }
				});
				return;
			}
			send(res, 404, { error: "not found" });
		} catch (e) {
			send(res, 500, { error: e.message });
		}
	}).listen(port, host, () => console.log(`task board: http://${host}:${port}/  (Ctrl+C stops it)`));
}
