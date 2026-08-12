import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeProvider } from "./common.js";
import { registerActionsTool } from "./actions.js";
import { registerContextTools } from "./context.js";
import { registerIssueTool } from "./issue.js";
import { registerNotificationTool } from "./notifications.js";
import { registerPullTool } from "./pull.js";
import { registerReviewTool } from "./review.js";
import { registerSearchTool } from "./search.js";

export function registerForgejoTools(pi: ExtensionAPI, runtimeProvider: RuntimeProvider): void {
  registerActionsTool(pi, runtimeProvider);
  registerContextTools(pi, runtimeProvider);
  registerIssueTool(pi, runtimeProvider);
  registerPullTool(pi, runtimeProvider);
  registerReviewTool(pi, runtimeProvider);
  registerNotificationTool(pi, runtimeProvider);
  registerSearchTool(pi, runtimeProvider);
}
