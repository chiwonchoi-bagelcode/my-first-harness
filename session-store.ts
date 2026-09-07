import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";

export async function saveSession(session: any, paths: HarnessPaths) {
  const { sessionDirectory } = paths;
  await mkdir(sessionDirectory, { recursive: true });

  await writeFile(
    join(sessionDirectory, `${session.id}.json`),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function loadSession(id: string, paths: HarnessPaths) {
  const content = await readFile(join(paths.sessionDirectory, `${id}.json`), "utf8");

  return JSON.parse(content);
}
