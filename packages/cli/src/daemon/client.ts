import { connect } from "node:net";
import { getDaemonSocketPath } from "@clockwerk/core";
import type { DaemonMessage, DaemonResponse } from "@clockwerk/core";

/**
 * Send a fire-and-forget event to the daemon.
 * Returns true if sent successfully, false if daemon not reachable.
 */
export function sendEvent(event: DaemonMessage & { type: "event" }): Promise<boolean> {
  return new Promise((resolve) => {
    const socketPath = getDaemonSocketPath();
    const client = connect(socketPath, () => {
      client.write(JSON.stringify(event) + "\n");
      client.end();
      resolve(true);
    });
    client.on("error", () => resolve(false));
    // Don't hang if daemon is slow
    client.setTimeout(1000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Send a query to the daemon and wait for a response.
 */
export function queryDaemon(
  method: string,
  params?: Record<string, unknown>,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socketPath = getDaemonSocketPath();
    const id = crypto.randomUUID();

    const msg: DaemonMessage = { type: "query", id, method, params };

    let buffer = "";
    const client = connect(socketPath, () => {
      client.write(JSON.stringify(msg) + "\n");
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const response = JSON.parse(line) as DaemonResponse;
          if (response.id === id) {
            client.end();
            resolve(response);
          }
        } catch {
          // Incomplete line, keep buffering
        }
      }
    });

    client.on("error", (err) => reject(err));
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error("Daemon query timed out"));
    });
  });
}
