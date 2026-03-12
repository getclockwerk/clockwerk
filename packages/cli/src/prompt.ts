import * as readline from "node:readline";

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    getRL().question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    getRL().question(`${question} ${hint} `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

export function choose(
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n${question}`);
    for (let i = 0; i < options.length; i++) {
      const marker = i === defaultIndex ? ">" : " ";
      console.log(`  ${marker} ${i + 1}. ${options[i]}`);
    }
    getRL().question(`Choice (1-${options.length}) [${defaultIndex + 1}]: `, (answer) => {
      const a = answer.trim();
      if (!a) return resolve(defaultIndex);
      const n = parseInt(a, 10);
      if (n >= 1 && n <= options.length) return resolve(n - 1);
      resolve(defaultIndex);
    });
  });
}

export function close(): void {
  rl?.close();
  rl = null;
}
