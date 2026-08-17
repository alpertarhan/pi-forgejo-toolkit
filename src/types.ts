import type { MutationApprovalKey } from "./mutation-approvals.js";

export type ServerAlias = string;

export type CredentialProviderKind = "env" | "fgj";

export interface ForgejoServerConfig {
  baseUrl: string;
  hostname: string;
  credentialProvider: CredentialProviderKind;
  tokenEnv?: string;
  fgjConfig?: string;
  remoteHosts: string[];
}

export type DashboardScope = "all" | "current";
export type NotificationLevel = "off" | "important" | "all";
export type PrivacyMode = "full" | "counts-only";

export interface DashboardConfig {
  enabled: boolean;
  scope: DashboardScope;
  refreshSeconds: number;
  previewLimit: number;
  notifications: NotificationLevel;
  privacy: PrivacyMode;
}

export interface ForgejoConfig {
  servers: Record<ServerAlias, ForgejoServerConfig>;
  dashboard: DashboardConfig;
  /** Stable mutation keys approved for automatic execution (global config only). */
  allowedMutations?: readonly MutationApprovalKey[];
}

export interface RepoRef {
  server: ServerAlias;
  owner: string;
  repo: string;
}

export interface ResourceRef extends RepoRef {
  kind: "issue" | "pull";
  index: number;
}

export interface GitRemote {
  name: string;
  url: string;
  direction: "fetch" | "push";
}

export interface ResolvedRemote extends RepoRef {
  remote: string;
  url: string;
}

export type RepoResolution =
  | { status: "resolved"; repo: RepoRef; remote: string }
  | { status: "none"; reason: string }
  | { status: "ambiguous"; matches: ResolvedRemote[]; reason: string };

export interface ForgejoUser {
  id: number;
  login: string;
  full_name?: string;
  avatar_url?: string;
  html_url?: string;
}

export interface ForgejoRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch?: string;
  owner?: ForgejoUser;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color?: string;
}

export interface ForgejoAttachment {
  id: number;
  name: string;
  size?: number;
  download_count?: number;
  created_at?: string;
  uuid?: string;
  browser_download_url?: string;
}

export interface ForgejoMilestone {
  id: number;
  title: string;
  description?: string;
  state?: string;
  open_issues?: number;
  closed_issues?: number;
  due_on?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface ForgejoTeam {
  id: number;
  name: string;
}

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: string;
  html_url: string;
  url?: string;
  updated_at: string;
  created_at?: string;
  closed_at?: string | null;
  due_date?: string | null;
  repository?: ForgejoRepository;
  repository_url?: string;
  user?: ForgejoUser;
  original_author?: string;
  original_author_id?: number;
  ref?: string;
  assignee?: ForgejoUser | null;
  assignees?: ForgejoUser[];
  labels?: ForgejoLabel[];
  milestone?: ForgejoMilestone | null;
  assets?: ForgejoAttachment[];
  comments?: number;
  is_locked?: boolean;
  pin_order?: number;
  pull_request?: Record<string, unknown> | null;
}

export interface ForgejoComment {
  id: number;
  html_url?: string;
  pull_request_url?: string;
  issue_url?: string;
  user?: ForgejoUser;
  original_author?: string;
  original_author_id?: number;
  body: string;
  assets?: ForgejoAttachment[];
  created_at: string;
  updated_at: string;
}

export interface ForgejoTrackedTime {
  id?: number;
  issue_id?: number;
  user_id?: number;
  user_name?: string;
  time?: number;
  created?: string;
}

export interface ForgejoTimelineEvent {
  id: number;
  type: string;
  html_url?: string;
  pull_request_url?: string;
  issue_url?: string;
  user?: ForgejoUser;
  body?: string;
  created_at: string;
  updated_at: string;
  old_project_id?: number;
  project_id?: number;
  old_milestone?: ForgejoMilestone | null;
  milestone?: ForgejoMilestone | null;
  tracked_time?: ForgejoTrackedTime | null;
  old_title?: string;
  new_title?: string;
  old_ref?: string;
  new_ref?: string;
  ref_issue?: ForgejoIssue | null;
  ref_comment?: ForgejoComment | null;
  ref_action?: string;
  ref_commit_sha?: string;
  review_id?: number;
  label?: ForgejoLabel | null;
  assignee?: ForgejoUser | null;
  assignee_team?: ForgejoTeam | null;
  removed_assignee?: boolean;
  resolve_doer?: ForgejoUser | null;
  dependent_issue?: ForgejoIssue | null;
}

export interface GitReference {
  label?: string;
  ref: string;
  sha: string;
  repo?: ForgejoRepository;
}

export interface ForgejoPullRequest extends ForgejoIssue {
  head: GitReference;
  base: GitReference;
  draft?: boolean;
  mergeable?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  merged_by?: ForgejoUser | null;
  comments?: number;
  review_comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  diff_url?: string;
  patch_url?: string;
  allow_maintainer_edit?: boolean;
  requested_reviewers?: ForgejoUser[];
  requested_reviewers_teams?: ForgejoTeam[];
}

export interface ForgejoChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  html_url?: string;
  contents_url?: string;
  raw_url?: string;
}

export interface ForgejoCommitIdentity {
  name: string;
  email?: string;
  date?: string;
}

export interface ForgejoCommit {
  sha: string;
  url?: string;
  html_url?: string;
  created?: string;
  commit?: {
    message: string;
    author?: ForgejoCommitIdentity;
    committer?: ForgejoCommitIdentity;
  };
  author?: ForgejoUser | null;
  committer?: ForgejoUser | null;
  stats?: {
    total: number;
    additions: number;
    deletions: number;
  };
}

export type ForgejoActionStatus =
  | "unknown"
  | "waiting"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "blocked";

export interface ForgejoActionRun {
  id: number;
  title: string;
  repository?: ForgejoRepository;
  workflow_id: string;
  index_in_repo: number;
  trigger_user?: ForgejoUser;
  prettyref: string;
  commit_sha: string;
  event: string;
  trigger_event?: string;
  status: ForgejoActionStatus;
  started: string;
  stopped: string;
  created: string;
  updated: string;
  duration?: number;
  html_url: string;
}

export interface ForgejoActionRunList {
  workflow_runs: Array<ForgejoActionRun | null>;
  total_count: number;
}

export interface ForgejoActionRunJob {
  id: number;
  run_id: number;
  attempt: number;
  handle: string;
  repo_id: number;
  owner_id: number;
  name: string;
  needs?: string[] | null;
  runs_on?: string[] | null;
  task_id: number;
  status: ForgejoActionStatus;
}

export interface ForgejoActionArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
  expired: boolean;
  run_id: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface ForgejoWorkflowDispatchRun {
  id: number;
  run_number: number;
  jobs: string[];
}

export type ForgejoCommitStatusState =
  | "pending"
  | "success"
  | "error"
  | "failure"
  | "warning"
  | "skipped";

export interface ForgejoCommitStatus {
  id: number;
  context: string;
  description?: string;
  status: ForgejoCommitStatusState;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ForgejoCombinedStatus {
  state: ForgejoCommitStatusState;
  sha: string;
  statuses: ForgejoCommitStatus[];
  total_count: number;
}

export interface ForgejoPullReview {
  id: number;
  user?: ForgejoUser;
  team?: ForgejoTeam;
  state:
    | "PENDING"
    | "APPROVED"
    | "REQUEST_CHANGES"
    | "COMMENT"
    | "REQUEST_REVIEW"
    | string;
  body?: string;
  official?: boolean;
  stale?: boolean;
  dismissed?: boolean;
  comments_count?: number;
  commit_id?: string;
  submitted_at?: string;
  updated_at?: string;
  html_url?: string;
  pull_request_url?: string;
}

export interface ForgejoPullReviewComment {
  id: number;
  body: string;
  user?: ForgejoUser;
  resolver?: ForgejoUser | null;
  pull_request_review_id: number;
  created_at: string;
  updated_at: string;
  path: string;
  commit_id: string;
  original_commit_id?: string;
  diff_hunk?: string;
  position: number;
  original_position?: number;
  extra_lines_count?: number;
  html_url?: string;
  pull_request_url?: string;
}

export interface ForgejoBranch {
  name: string;
  protected: boolean;
  enable_status_check: boolean;
  required_approvals: number;
  status_check_contexts?: string[];
  user_can_merge: boolean;
}

export interface NotificationSubject {
  title: string;
  type: "Issue" | "Pull" | "Repository" | string;
  state?: string;
  url?: string;
  latest_comment_url?: string;
  html_url?: string;
  latest_comment_html_url?: string;
}

export interface ForgejoNotification {
  id: number;
  unread: boolean;
  pinned: boolean;
  updated_at: string;
  url?: string;
  subject: NotificationSubject;
  repository: ForgejoRepository;
}

export interface ForgejoWatchInfo {
  subscribed: boolean;
  ignored: boolean;
  reason?: string | null;
  created_at?: string | null;
  url?: string;
  repository_url?: string;
}

export interface ApiResult<T> {
  data: T;
  status: number;
  headers: Headers;
  totalCount?: number;
  truncated?: boolean;
}

export type ServerHealth = "loading" | "ready" | "auth-error" | "error";
export type DashboardItemKind =
  | "assigned"
  | "authored-pull"
  | "review"
  | "notification"
  | "ci-failed";

export interface DashboardItem {
  key: string;
  server: ServerAlias;
  owner: string;
  repo: string;
  kind: DashboardItemKind;
  resourceKind: "issue" | "pull" | "repository";
  index?: number;
  title: string;
  updatedAt: string;
  webUrl: string;
  unread?: boolean;
  sourceId?: number;
}

export interface DashboardCollection {
  total: number;
  items: DashboardItem[];
}

export interface ServerDashboard {
  alias: ServerAlias;
  health: ServerHealth;
  fetchedAt?: string;
  error?: string;
  identity?: ForgejoUser;
  assignedIssues: DashboardCollection;
  authoredPulls: DashboardCollection;
  reviewRequests: DashboardCollection;
  notifications: DashboardCollection;
  failedRuns: DashboardCollection;
  actionsError?: string;
}

export interface DashboardTotals {
  assignedIssues: number;
  authoredPulls: number;
  reviewRequests: number;
  notifications: number;
  failedRuns: number;
}

export interface DashboardSnapshot {
  fetchedAt?: string;
  backgroundError?: string;
  activeRepo?: RepoRef;
  servers: Record<ServerAlias, ServerDashboard>;
  totals: DashboardTotals;
  attention: DashboardItem[];
  refreshing: boolean;
}

export type ForgejoFeatureAvailability =
  | "unknown"
  | "available"
  | "unavailable";

export interface ForgejoCapabilities {
  server: ServerAlias;
  version: string;
  user: ForgejoUser;
  paging: {
    defaultLimit?: number;
    maxLimit?: number;
  };
  features: {
    dashboardSearch: boolean;
    notifications: boolean;
    reviews: boolean;
    actionsRuns: ForgejoFeatureAvailability;
    actionsDispatch: ForgejoFeatureAvailability;
    actionsCancel: ForgejoFeatureAvailability;
    actionsRerun: ForgejoFeatureAvailability;
    actionsArtifacts: ForgejoFeatureAvailability;
  };
}

export interface ReviewDraftComment {
  path: string;
  body: string;
  newPosition?: number;
  oldPosition?: number;
}

export interface ReviewDraft {
  ref: ResourceRef;
  body: string;
  verdict: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  commitId?: string;
  comments: ReviewDraftComment[];
  createdAt: string;
  previewedAt?: string;
}
