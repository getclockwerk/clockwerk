import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryDaemon, sendEvent } from "../daemon/client";
import { isDaemonRunning } from "../daemon/server";
import { findProjectConfig, type ClockwerkEvent } from "@clockwerk/core";
import { spawn } from "node:child_process";

export async function startMcpServer(): Promise<void> {
  // Auto-start daemon if not running
  if (!isDaemonRunning()) {
    spawn(process.execPath, ["up", "--foreground"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    await new Promise((r) => setTimeout(r, 500));
  }

  const server = new McpServer({
    name: "clockwerk",
    version: "0.0.1",
  });

  // --- Tools ---

  server.registerTool(
    "clockwerk_status",
    {
      description:
        "Show time tracking status — how much time has been logged today, this week, or this month",
      inputSchema: {
        period: z
          .enum(["today", "week", "month"])
          .optional()
          .describe("Time period to check (default: today)"),
      },
    },
    async ({ period }) => {
      const p = period ?? "today";
      const project = findProjectConfig(process.cwd());

      try {
        const res = await queryDaemon("sessions", {
          period: p,
          project_token: project?.project_token,
        });

        const data = res.data as {
          sessions: Array<{
            source: string;
            duration_seconds: number;
            branch?: string;
            issue_id?: string;
            topics: string[];
          }>;
          total_seconds: number;
        };

        const hours = Math.floor(data.total_seconds / 3600);
        const minutes = Math.floor((data.total_seconds % 3600) / 60);
        const dur = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

        let text = `${capitalize(p)}: ${dur} across ${data.sessions.length} session(s)`;

        if (data.sessions.length > 0) {
          text += "\n\nSessions:";
          for (const s of data.sessions) {
            const sDur = formatDur(s.duration_seconds);
            const parts = [sDur, s.source];
            if (s.issue_id) parts.push(s.issue_id);
            if (s.branch) parts.push(s.branch);
            text += `\n  ${parts.join(" · ")}`;
            if (s.topics.length > 0) {
              text += ` (${s.topics.slice(0, 3).join(", ")})`;
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
      description:
        "Manually log time spent on a task — use this when the user asks to log or track time for something",
      inputSchema: {
        duration: z.string().describe('Duration to log, e.g. "2h", "45m", "1h30m"'),
        description: z.string().optional().describe("What the time was spent on"),
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
      const interval = 240; // 4 minutes

      const events: ClockwerkEvent[] = [];
      for (let ts = startTs; ts <= now; ts += interval) {
        events.push({
          id: crypto.randomUUID(),
          timestamp: ts,
          event_type: "manual",
          source: "manual",
          project_token: project.project_token,
          context: {
            description,
            topic: description,
          },
          harness_session_id: `manual:${startTs}`,
        });
      }

      for (const event of events) {
        await sendEvent({ type: "event", data: event });
      }

      const dur = formatDur(seconds);
      const text = `Logged ${dur}${description ? `: ${description}` : ""}`;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "clockwerk_sessions",
    {
      description:
        "List recent tracked sessions with details — branches, issues, topics, and sources",
      inputSchema: {
        period: z
          .enum(["today", "week", "month"])
          .optional()
          .describe("Time period (default: today)"),
        limit: z.number().optional().describe("Max sessions to return (default: 10)"),
      },
    },
    async ({ period, limit }) => {
      const p = period ?? "today";
      const maxSessions = limit ?? 10;
      const project = findProjectConfig(process.cwd());

      try {
        const res = await queryDaemon("sessions", {
          period: p,
          project_token: project?.project_token,
        });

        const data = res.data as {
          sessions: Array<{
            start_ts: number;
            end_ts: number;
            source: string;
            duration_seconds: number;
            branch?: string;
            issue_id?: string;
            topics: string[];
            file_areas: string[];
            event_count: number;
          }>;
          total_seconds: number;
        };

        if (data.sessions.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No sessions found for ${p}.` }],
          };
        }

        const sessions = data.sessions.slice(0, maxSessions);
        let text = `${capitalize(p)}: ${formatDur(data.total_seconds)} total, ${data.sessions.length} session(s)\n`;

        for (const s of sessions) {
          const start = new Date(s.start_ts * 1000).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          });
          const end = new Date(s.end_ts * 1000).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          });
          text += `\n${start}–${end}  ${formatDur(s.duration_seconds)}  [${s.source}]`;
          if (s.issue_id) text += `  ${s.issue_id}`;
          if (s.branch) text += `  (${s.branch})`;
          if (s.topics.length > 0) text += `\n  topics: ${s.topics.join(", ")}`;
          if (s.file_areas.length > 0) text += `\n  files: ${s.file_areas.join(", ")}`;
          text += `\n  ${s.event_count} events`;
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

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDur(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

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
