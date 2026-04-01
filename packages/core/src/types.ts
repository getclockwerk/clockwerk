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
  | "cursor"
  | "copilot"
  | "chatgpt"
  | "manual"
  | "file-watch"
  | "autonomous";

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

export interface Session {
  id: string;
  project_token: string;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source: string;
}

/** Locally-materialized session with sync tracking fields. */
export interface LocalSession extends Session {
  sync_version: number;
  synced_version: number;
  deleted_at?: number;
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
  harnesses: Record<string, boolean>;
  session_gap?: number; // gap in seconds between sessions, defaults to SESSION_GAP (1500)
  watch?: WatchConfig;
  plugins?: (PluginConfig | string)[];
}

export interface ProjectRegistryEntry {
  project_token: string;
  directory: string;
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
