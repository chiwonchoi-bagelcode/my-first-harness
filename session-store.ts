import { mkdir, readFile, writeFile } from "node:fs/promises";

const sessionDirectory = ".my-first-harness/sessions";

export async function saveSession(session: any) {
  await mkdir(sessionDirectory, { recursive: true });

  await writeFile(
    `${sessionDirectory}/${session.id}.json`,
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function loadSession(id: string) {
  const content = await readFile(`${sessionDirectory}/${id}.json`, "utf8");

  return JSON.parse(content);
}
