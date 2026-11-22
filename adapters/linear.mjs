// Linear (stub). Becomes the linear skill.
import { adapter } from "./base.mjs";
export default adapter({ name: "linear", columns: { backlog: "Backlog", planned: "Todo", doing: "In Progress", blocked: "Blocked", review: "In Review", done: "Done" } });
