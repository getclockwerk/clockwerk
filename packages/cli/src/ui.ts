import pc from "picocolors";
import { consola } from "consola";

export { pc, consola };

/** Label used for prefixed output (replaces [clockwerk]) */
const LABEL = pc.dim("clockwerk");

/** Prefixed log: `clockwerk · message` */
export function log(msg: string): void {
  console.log(`${LABEL} ${pc.dim("·")} ${msg}`);
}

/** Green checkmark + message */
export function success(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

/** Red cross + message */
export function error(msg: string): void {
  console.error(`${pc.red("✗")} ${msg}`);
}

/** Yellow warning + message */
export function warn(msg: string): void {
  console.error(`${pc.yellow("!")} ${msg}`);
}

/** Blue info + message */
export function info(msg: string): void {
  console.log(`${pc.blue("i")} ${msg}`);
}

/** Dim text */
export function dim(msg: string): void {
  console.log(pc.dim(msg));
}

/** Format a label: value pair */
export function kv(label: string, value: string, indent = 2): void {
  const pad = " ".repeat(indent);
  console.log(`${pad}${pc.dim(label)} ${value}`);
}

/** Styled section header */
export function heading(text: string): void {
  console.log(`\n${pc.bold(text)}`);
}

/** Styled status badge */
export function badge(
  label: string,
  variant: "success" | "error" | "warn" | "dim" = "dim",
): string {
  const color = {
    success: pc.green,
    error: pc.red,
    warn: pc.yellow,
    dim: pc.dim,
  }[variant];
  return color(label);
}

/** Start a spinner, returns stop function */
export function spinner(msg: string): { stop: (finalMsg?: string) => void } {
  const frames = ["◐", "◓", "◑", "◒"];
  let i = 0;
  let running = true;

  const interval = setInterval(() => {
    process.stdout.write(`\r${pc.cyan(frames[i % frames.length])} ${msg}`);
    i++;
  }, 100);

  return {
    stop(finalMsg?: string) {
      if (!running) return;
      running = false;
      clearInterval(interval);
      if (finalMsg) {
        process.stdout.write(`\r${pc.green("✓")} ${finalMsg}\n`);
      } else {
        process.stdout.write("\r" + " ".repeat(msg.length + 4) + "\r");
      }
    },
  };
}
