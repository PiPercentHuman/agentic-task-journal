// The shape every ticket-system adapter has. None of them fetches anything yet: each will become a skill
// (jira, github-issues, linear, ...) that fills these in. The board side is ready: a card's `external` field holds
// { "<adapter>": { "id": "...", "url": "...", "syncedAt": "...", "hash": "..." } }, and the card's history (events)
// is what a push sends since `syncedAt`.
//
//   name                        the key under card.external
//   mapColumn(column)           board column -> the system's status name
//   unmapStatus(status)         the system's status -> board column
//   pull({ project, since })    -> [{ externalId, title, status, url, steps?: [{ title, done }] }]   (not built)
//   push(card, events)          -> { externalId, url }                                               (not built)
export const notBuilt = (name, verb) => {
	throw new Error(`${name}.${verb}: not built yet (the adapter is a stub; it becomes the ${name} skill)`);
};
export function adapter({ name, columns }) {
	const back = Object.fromEntries(Object.entries(columns).map(([k, v]) => [String(v).toLowerCase(), k]));
	return {
		name,
		mapColumn: (c) => columns[c] ?? c,
		unmapStatus: (s) => back[String(s).toLowerCase()] ?? "planned",
		pull: () => notBuilt(name, "pull"),
		push: () => notBuilt(name, "push"),
	};
}
