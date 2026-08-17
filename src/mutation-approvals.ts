export const MUTATION_APPROVAL_KEYS = [
	"actions.artifact.overwrite",
	"actions.run.cancel",
	"actions.run.rerun",
	"actions.workflow.dispatch",
	"comment.issue.delete",
	"comment.pull.delete",
	"issue.close",
	"notifications.mark-read",
	"pull.close",
	"pull.mark-ready",
	"pull.merge",
	"review.submit",
] as const;

export type MutationApprovalKey = (typeof MUTATION_APPROVAL_KEYS)[number];
