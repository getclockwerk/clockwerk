export class DaemonNotRunningError extends Error {
  constructor() {
    super("Daemon is not running");
    this.name = "DaemonNotRunningError";
  }
}
