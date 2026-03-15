import pull from "./pull";
import push from "./push";

export default async function sync(args: string[]): Promise<void> {
  await pull(args);
  await push(args);
}
