import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isDaemonRunning } from "../daemon/server";
import {
  queryDaemon,
  sendEvent,
  findProjectConfig,
  getUserConfig,
  getProjectRegistry,
  type ClockwerkEvent,
  type Session,
} from "@clockwerk/core";
import { formatDuration } from "../format";
import { spawn } from "node:child_process";

// ---------- Types ----------

interface SessionsData {
  sessions: Session[];
  total_seconds: number;
}

interface DaemonStatus {
  running: boolean;
  pid: number;
  buffered_events: number;
  plugins?: {
    name: string;
    source: string;
    running: boolean;
    eventCount: number;
    lastEventTs: number | null;
  }[];
}

type Period = "today" | "yesterday" | "week" | "month" | "all";

// ---------- Helpers ----------

function parseDuration(str: string): number {
  let total = 0;
  const hourMatch = str.match(/(\d+)h/);
  const minMatch = str.match(/(\d+)m/);
  if (hourMatch) total += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) total += parseInt(minMatch[1], 10) * 60;
  if (!hourMatch && !minMatch) {
    const n = parseInt(str, 10);
    if (!isNaN(n)) total = n * 60;
  }
  return total;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function ensureDaemon(): Promise<void> {
  if (!isDaemonRunning()) {
    spawn(process.execPath, ["up", "--foreground"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function getSessions(period: Period, projectToken?: string): Promise<SessionsData> {
  const res = await queryDaemon("sessions", {
    period,
    project_token: projectToken,
  });
  return res.data as SessionsData;
}

function formatSessionLine(s: Session): string {
  const date = formatDate(s.start_ts);
  const start = formatTime(s.start_ts);
  const end = formatTime(s.end_ts);
  const dur = formatDuration(s.duration_seconds);

  let line = `${date} ${start}-${end}  ${dur}  [${s.source}]`;
  if (s.issue_id) line += `  ${s.issue_id}`;
  if (s.branch) line += `  (${s.branch})`;
  return line;
}

function formatSessionDetail(s: Session): string {
  let text = `[${s.id}] ${formatSessionLine(s)}`;
  if (s.description) text += `\n  description: ${s.description}`;
  if (s.topics.length > 0) text += `\n  topics: ${s.topics.join(", ")}`;
  if (s.file_areas.length > 0) text += `\n  files: ${s.file_areas.join(", ")}`;
  if (s.commits && s.commits.length > 0) {
    text += `\n  commits: ${s.commits.map((c) => `${c.hash} ${c.message}`).join(", ")}`;
  }
  if (s.tools_used && s.tools_used.length > 0) {
    text += `\n  tools: ${s.tools_used.join(", ")}`;
  }
  text += `\n  ${s.event_count} events`;
  return text;
}

// ---------- Server ----------

export async function startMcpServer(): Promise<void> {
  await ensureDaemon();

  const server = new McpServer({ name: "clockwerk", version: "1.0.0" });

  const getProjectToken = () => findProjectConfig(process.cwd())?.project_token;

  // ==================== TOOLS ====================

  server.registerTool(
    "clockwerk_status",
    {
      title: "Time Tracking Status",
      description:
        "Show time tracking summary - how much time has been logged today, this week, or this month. " +
        "Returns total duration and a breakdown by session.",
      inputSchema: {
        period: z
          .enum(["today", "yesterday", "week", "month"])
          .optional()
          .describe("Time period to check (default: today)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ period }) => {
      const p = period ?? "today";
      const projectToken = getProjectToken();

      try {
        const data = await getSessions(p, projectToken);

        const dur = formatDuration(data.total_seconds);
        let text = `${capitalize(p)}: ${dur} across ${data.sessions.length} session(s)`;

        if (data.sessions.length > 0) {
          text += "\n\nSessions:";
          for (const s of data.sessions) {
            text += `\n  ${formatSessionLine(s)}`;
            if (s.topics.length > 0) {
              text += ` - ${s.topics.slice(0, 3).join(", ")}`;
            }
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Daemon is not running. Start it with `clockwerk up`.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "clockwerk_log_time",
    {
      title: "Log Time",
      description:
        "Manually log time spent on a task. Use when the user asks to log, record, or track time " +
        "for an activity like a meeting, code review, or non-coding work.",
      inputSchema: {
        duration: z.string().describe('Duration to log, e.g. "2h", "45m", "1h30m"'),
        description: z.string().optional().describe("What the time was spent on"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ duration, description }) => {
      const project = findProjectConfig(process.cwd());
      if (!project) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not in a tracked project. Run `clockwerk init <token>` first.",
            },
          ],
          isError: true,
        };
      }

      const seconds = parseDuration(duration);
      if (seconds <= 0) {
        return {
          content: [{ type: "text" as const, text: `Invalid duration: ${duration}` }],
          isError: true,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const startTs = now - seconds;
      const interval = 240; // 4 minutes between events to form a session
      const sessionId = `manual:${startTs}`;

      const events: ClockwerkEvent[] = [];
      for (let ts = startTs; ts <= now; ts += interval) {
        events.push({
          id: crypto.randomUUID(),
          timestamp: ts,
          event_type: "manual",
          source: "manual",
          project_token: project.project_token,
          context: { description, topic: description },
          harness_session_id: sessionId,
        });
      }

      for (const event of events) {
        await sendEvent({ type: "event", data: event });
      }

      const text = `Logged ${formatDuration(seconds)}${description ? `: ${description}` : ""}`;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "clockwerk_sessions",
    {
      title: "List Sessions",
      description:
        "List tracked sessions with full details - timestamps, branches, issues, topics, " +
        "file areas, commits, and tools used. Use for detailed time breakdowns or generating reports.",
      inputSchema: {
        period: z
          .enum(["today", "yesterday", "week", "month"])
          .optional()
          .describe("Time period (default: today)"),
        limit: z.number().optional().describe("Max sessions to return (default: 10)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ period, limit }) => {
      const p = period ?? "today";
      const maxSessions = limit ?? 10;
      const projectToken = getProjectToken();

      try {
        const data = await getSessions(p, projectToken);

        if (data.sessions.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No sessions found for ${p}.` }],
          };
        }

        const sessions = data.sessions.slice(0, maxSessions);

        let text = `${capitalize(p)}: ${formatDuration(data.total_seconds)} total, ${data.sessions.length} session(s)\n`;

        for (const s of sessions) {
          text += `\n${formatSessionDetail(s)}`;
        }

        if (data.sessions.length > maxSessions) {
          text += `\n\n... and ${data.sessions.length - maxSessions} more session(s)`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Daemon is not running. Start it with `clockwerk up`.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "clockwerk_update_session",
    {
      title: "Update Session",
      description:
        "Update a session's description and structured summary. Use after generating a summary to write it back to the session.",
      inputSchema: {
        session_id: z.string().describe("The session ID to update"),
        description: z
          .string()
          .describe(
            "Plain text description (1-2 sentences). Used as fallback when structured summary is not available.",
          ),
        summary: z
          .string()
          .describe(
            'Structured summary as a JSON string. Must follow the schema: {"v":1,"blocks":[...]} where blocks are: ' +
              '{"type":"text","content":"..."} for narrative paragraphs, ' +
              '{"type":"highlights","items":["..."]} for key accomplishments, ' +
              '{"type":"tags","items":["..."]} for inferred topic tags.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, description, summary }) => {
      try {
        const res = await queryDaemon("update_session", {
          session_id,
          description,
          summary,
        });
        const data = res.data as { ok?: boolean; error?: string };

        if (data.error) {
          return {
            content: [{ type: "text" as const, text: data.error }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} updated.`,
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Daemon is not running. Start it with `clockwerk up`.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ==================== RESOURCES ====================

  // Static resource: current daemon status
  server.registerResource(
    "daemon-status",
    "clockwerk://status",
    {
      title: "Daemon Status",
      description:
        "Current Clockwerk daemon status - running state, PID, plugins, buffered events",
      mimeType: "application/json",
    },
    async () => {
      try {
        const res = await queryDaemon("status");
        const status = res.data as DaemonStatus;
        return {
          contents: [
            {
              uri: "clockwerk://status",
              text: JSON.stringify(
                {
                  running: status.running,
                  pid: status.pid,
                  buffered_events: status.buffered_events,
                  plugins: status.plugins ?? [],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "clockwerk://status",
              text: JSON.stringify({ running: false, error: "Daemon not reachable" }),
            },
          ],
        };
      }
    },
  );

  // Static resource: project config for the current working directory
  server.registerResource(
    "project-config",
    "clockwerk://project",
    {
      title: "Project Config",
      description:
        "Clockwerk project configuration for the current directory - token, harnesses, watch settings",
      mimeType: "application/json",
    },
    async () => {
      const config = findProjectConfig(process.cwd());
      return {
        contents: [
          {
            uri: "clockwerk://project",
            text: config
              ? JSON.stringify(config, null, 2)
              : JSON.stringify({ error: "No .clockwerk config found in this directory" }),
          },
        ],
      };
    },
  );

  // Static resource: user config
  server.registerResource(
    "user-config",
    "clockwerk://user",
    {
      title: "User Config",
      description: "Clockwerk user authentication state - logged-in email and API URL",
      mimeType: "application/json",
    },
    async () => {
      const config = getUserConfig();
      return {
        contents: [
          {
            uri: "clockwerk://user",
            text: config
              ? JSON.stringify(
                  { email: config.email, api_url: config.api_url, authenticated: true },
                  null,
                  2,
                )
              : JSON.stringify({ authenticated: false }),
          },
        ],
      };
    },
  );

  // Static resource: registered projects
  server.registerResource(
    "projects",
    "clockwerk://projects",
    {
      title: "Registered Projects",
      description: "All Clockwerk-tracked project directories and their tokens",
      mimeType: "application/json",
    },
    async () => {
      const registry = getProjectRegistry();
      return {
        contents: [
          {
            uri: "clockwerk://projects",
            text: JSON.stringify(registry, null, 2),
          },
        ],
      };
    },
  );

  // Template resource: sessions by period
  server.registerResource(
    "sessions-by-period",
    new ResourceTemplate("clockwerk://sessions/{period}", {
      list: async () => ({
        resources: [
          { uri: "clockwerk://sessions/today", name: "Today's sessions" },
          { uri: "clockwerk://sessions/week", name: "This week's sessions" },
          { uri: "clockwerk://sessions/month", name: "This month's sessions" },
        ],
      }),
    }),
    {
      title: "Sessions by Period",
      description:
        "Tracked time sessions for a given period (today, week, month) as JSON",
      mimeType: "application/json",
    },
    async (uri, { period }) => {
      const p = (period as Period) ?? "today";
      const projectToken = getProjectToken();

      try {
        const data = await getSessions(p, projectToken);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(
                {
                  period: p,
                  total_seconds: data.total_seconds,
                  total_formatted: formatDuration(data.total_seconds),
                  session_count: data.sessions.length,
                  sessions: data.sessions,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: "Daemon not running" }),
            },
          ],
        };
      }
    },
  );

  // ==================== PROMPTS ====================

  server.registerPrompt(
    "time-report",
    {
      title: "Time Report",
      description:
        "Generate a formatted time report for a given period, suitable for sharing with clients or managers",
      argsSchema: {
        period: z
          .enum(["today", "yesterday", "week", "month"])
          .optional()
          .describe("Period to report on (default: week)"),
      },
    },
    async ({ period }) => {
      const p = (period as Period) ?? "week";
      const projectToken = getProjectToken();

      let sessionsText: string;
      try {
        const data = await getSessions(p, projectToken);
        sessionsText = JSON.stringify(data, null, 2);
      } catch {
        sessionsText = '{"error": "Could not fetch sessions - is the daemon running?"}';
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Generate a clean, professional time report for ${p}. ` +
                `Group sessions by date, show total hours per day and grand total. ` +
                `Include branch names and topics where available. ` +
                `Format it as a summary suitable for a client or project manager.\n\n` +
                `Session data:\n${sessionsText}`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "standup",
    {
      title: "Standup Notes",
      description:
        "Generate daily standup notes from yesterday's and today's tracked sessions",
    },
    async () => {
      const projectToken = getProjectToken();

      let todayText: string;
      let yesterdayText: string;
      let weekText: string;
      try {
        const [today, yesterday, week] = await Promise.all([
          getSessions("today", projectToken),
          getSessions("yesterday", projectToken),
          getSessions("week", projectToken),
        ]);
        todayText = JSON.stringify(today, null, 2);
        yesterdayText = JSON.stringify(yesterday, null, 2);
        weekText = JSON.stringify(week, null, 2);
      } catch {
        todayText = '{"error": "Could not fetch sessions"}';
        yesterdayText = todayText;
        weekText = todayText;
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Generate concise standup notes based on my tracked development sessions. ` +
                `Use the standard format:\n` +
                `- **Yesterday**: what I worked on\n` +
                `- **Today**: what I plan to work on (infer from recent context)\n` +
                `- **Blockers**: any (say "none" if unclear)\n\n` +
                `Derive the content from branches, topics, commits, and file areas. ` +
                `Keep it brief and actionable.\n\n` +
                `Yesterday's sessions:\n${yesterdayText}\n\n` +
                `Today's sessions:\n${todayText}\n\n` +
                `This week's sessions (for broader context):\n${weekText}`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "invoice-summary",
    {
      title: "Invoice Summary",
      description:
        "Generate an invoice-ready time summary grouped by date with total billable hours",
      argsSchema: {
        period: z
          .enum(["week", "month"])
          .optional()
          .describe("Billing period (default: month)"),
        rate: z.string().optional().describe("Hourly rate, e.g. '150' or '150 EUR'"),
      },
    },
    async ({ period, rate }) => {
      const p = (period as Period) ?? "month";
      const projectToken = getProjectToken();

      let sessionsText: string;
      try {
        const data = await getSessions(p, projectToken);
        sessionsText = JSON.stringify(data, null, 2);
      } catch {
        sessionsText = '{"error": "Could not fetch sessions"}';
      }

      const rateNote = rate
        ? `The hourly rate is ${rate}. Calculate and include the total amount.`
        : "Do not include monetary amounts - just list the hours.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Generate an invoice-ready time summary for ${p}. ` +
                `Group entries by date. For each date, list the work done (derived from topics, branches, commits) ` +
                `and the duration. Include a grand total of hours at the bottom. ` +
                `${rateNote}\n\n` +
                `Session data:\n${sessionsText}`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "summarize",
    {
      title: "Summarize Sessions",
      description:
        "Generate descriptions for tracked sessions in a given period and save them back",
      argsSchema: {
        period: z
          .enum(["today", "yesterday", "week", "month"])
          .optional()
          .describe("Period to summarize (default: yesterday)"),
      },
    },
    async ({ period }) => {
      const p = (period as string) ?? "yesterday";
      const projectToken = getProjectToken();

      let sessionsText: string;
      try {
        const queryPeriod = p === "yesterday" ? "yesterday" : p;
        const data = await getSessions(queryPeriod as Period, projectToken);
        sessionsText = JSON.stringify(data, null, 2);
      } catch {
        sessionsText = '{"error": "Could not fetch sessions - is the daemon running?"}';
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Summarize my tracked sessions for ${p}. For each session, generate both a plain text description ` +
                `and a structured summary. Derive everything from the session's branches, topics, commits, file areas, and tools used.\n\n` +
                `For the **description** parameter: write 1-2 sentences of plain text describing what was worked on.\n\n` +
                `For the **summary** parameter: provide a JSON string with this exact schema:\n` +
                `{"v":1,"blocks":[` +
                `{"type":"text","content":"1-2 sentence narrative of what was done"},` +
                `{"type":"highlights","items":["key accomplishment 1","key accomplishment 2"]},` +
                `{"type":"tags","items":["tag1","tag2"]}` +
                `]}\n\n` +
                `Block types:\n` +
                `- "text": A narrative paragraph (required, always include one)\n` +
                `- "highlights": Bullet-point list of key changes or accomplishments (include when there are distinct items to list)\n` +
                `- "tags": Short topic tags inferred from the work, e.g. "auth", "refactor", "api", "bugfix" (include when tags can be inferred)\n\n` +
                `Use the clockwerk_update_session tool to save both the description and summary to each session. ` +
                `Skip sessions that already have a description.\n\n` +
                `Session data:\n${sessionsText}`,
            },
          },
        ],
      };
    },
  );

  // ==================== Connect ====================

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
