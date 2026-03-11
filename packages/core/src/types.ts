export type EventType =
  | "tool_call"
  | "file_edit"
  | "file_read"
  | "chat_message"
  | "completion_accept"
  | "git_commit"
  | "manual"
  | "heartbeat";

export type Source =
  | "claude-code"
  | "codex"
  | "cursor"
  | "copilot"
  | "chatgpt"
  | "aider"
  | "manual"
  | "file-watch";

/** Slug pattern for source identifiers: lowercase alphanumeric, hyphens, colons. 2-64 chars. */
const SOURCE_SLUG_RE = /^[a-z0-9]([a-z0-9:-]*[a-z0-9])?$/;

export function isValidSource(source: string): boolean {
  return source.length >= 2 && source.length <= 64 && SOURCE_SLUG_RE.test(source);
}

export interface ClockwerkEvent {
  id: string;
  timestamp: number;
  event_type: EventType;
  source: Source | string;
  project_token: string;
  context: EventContext;
  harness_session_id?: string;
}

export interface EventContext {
  tool_name?: string;
  description?: string;
  file_path?: string; // relative to project root
  branch?: string;
  issue_id?: string;
  topic?: string;
}

export interface SessionCommit {
  hash: string;
  message: string;
  ts: number;
}

export interface EventTypeBreakdown {
  [eventType: string]: number;
}

export interface Session {
  id: string;
  project_token: string;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source: string;
  branch?: string;
  issue_id?: string;
  topics: string[];
  file_areas: string[];
  event_count: number;
  description?: string;
  commits?: SessionCommit[];
  // Enriched data for better AI categorization
  event_types?: EventTypeBreakdown;
  files_changed?: string[];
  tools_used?: string[];
  source_breakdown?: Record<string, number>;
}

export interface WatchConfig {
  enabled: boolean;
  interval: number; // heartbeat window in seconds
  exclude: string[]; // additional glob patterns to ignore
}

export interface PluginConfig {
  name: string;
  command: string;
  event_type: EventType;
  source: string;
  interval?: number; // min seconds between events (throttle), default 1
}

export interface ProjectConfig {
  version: 1;
  project_name?: string;
  project_token: string;
  api_url?: string;
  privacy: PrivacyConfig;
  harnesses: Record<string, boolean>;
  watch?: WatchConfig;
  plugins?: PluginConfig[];
}

export function isLocalToken(token: string): boolean {
  return token.startsWith("local_");
}

export interface ProjectRegistryEntry {
  project_token: string;
  directory: string;
}

export interface PrivacyConfig {
  sync_paths: boolean;
  sync_branches: boolean;
  sync_descriptions: boolean;
}

export interface UserConfig {
  user_id: string;
  email: string;
  token: string;
  api_url: string;
}

// Socket protocol messages
export type DaemonMessage =
  | { type: "event"; data: ClockwerkEvent }
  | { type: "query"; id: string; method: string; params?: Record<string, unknown> };

export type DaemonResponse = {
  type: "response";
  id: string;
  data: unknown;
  error?: string;
};
