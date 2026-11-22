// GitHub Issues / Projects (stub). Becomes the github-issues skill: an issue per card, its milestones as a task list,
// the column as a Projects status field (or a label).
import { adapter } from "./base.mjs";
export default adapter({ name: "github-issues", columns: { backlog: "Backlog", planned: "Todo", doing: "In Progress", blocked: "Blocked", review: "In Review", done: "Done" } });
