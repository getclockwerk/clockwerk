import { consola } from "consola";

const CANCEL = Symbol.for("cancel");

function cancelled(value: unknown): value is symbol {
  return value === CANCEL;
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const result = await consola.prompt(question, {
    type: "text",
    default: defaultValue,
    placeholder: defaultValue,
  });
  if (cancelled(result)) process.exit(0);
  return (result as string) || defaultValue || "";
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const result = await consola.prompt(question, {
    type: "confirm",
    initial: defaultYes,
  });
  if (cancelled(result)) process.exit(0);
  return result as boolean;
}

export async function choose(
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  const result = await consola.prompt(question, {
    type: "select",
    options: options.map((label, i) => ({ label, value: String(i) })),
    initial: String(defaultIndex),
  });
  if (cancelled(result)) process.exit(0);
  return parseInt(result as string, 10);
}
