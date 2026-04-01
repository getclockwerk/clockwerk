import { z } from "zod";

const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PLUGIN_SOURCE_RE = /^[a-z0-9]([a-z0-9:-]*[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export const EVENT_TYPES = [
  "tool_call",
  "file_edit",
  "file_read",
  "chat_message",
  "completion_accept",
  "git_commit",
  "manual",
  "heartbeat",
] as const;

export const PluginManifestSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(PLUGIN_NAME_RE, "Plugin name must be lowercase alphanumeric with hyphens"),
  version: z.string().regex(SEMVER_RE, "Version must be in semver format (e.g. 1.0.0)"),
  display_name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  event_type: z.enum(EVENT_TYPES),
  source: z
    .string()
    .min(2)
    .max(64)
    .regex(
      PLUGIN_SOURCE_RE,
      "Source must be a valid slug (lowercase alphanumeric, hyphens, colons)",
    ),
  command: z.string().min(1),
  interval: z.number().int().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
