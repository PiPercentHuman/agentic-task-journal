// Jira (stub). Becomes the jira skill: REST v3 /search for pull, /issue for push, transitions for columns.
import { adapter } from "./base.mjs";
export default adapter({ name: "jira", columns: { backlog: "Backlog", planned: "To Do", doing: "In Progress", blocked: "Blocked", review: "In Review", done: "Done" } });
