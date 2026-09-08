import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";
import type { Message } from "./llm-types.ts";
import { checkSessionId } from "./execution-history.ts";

// resume에 필요한 현재 상태만 담는다. 원문·실행 이력은 별도 JSONL에 저장한다.
export type Session = {
  id: string;
  workspaceDirectory: string;
  system: string;
  messages: Message[];
};

// 현재 세션 상태를 JSON 스냅샷에 저장하며 실행 기록 JSONL은 건드리지 않는다.
export async function saveSession(session: Session, paths: HarnessPaths) {
  checkSessionId(session.id);
  const { sessionDirectory } = paths;
  await mkdir(sessionDirectory, { recursive: true });

  await writeFile(
    join(sessionDirectory, `${session.id}.json`),
    JSON.stringify({ version: 2, id: session.id, workspaceDirectory: session.workspaceDirectory,
      system: session.system, messages: session.messages }, null, 2),
    "utf8",
  );
}

// ID에 해당하는 세션 JSON을 읽고 현재 형식인지 확인해 반환한다.
export async function loadSession(id: string, paths: HarnessPaths): Promise<Session> {
  checkSessionId(id);
  const content = await readFile(join(paths.sessionDirectory, `${id}.json`), "utf8");

  const session = JSON.parse(content);
  if (session.version !== 2 || session.id !== id || typeof session.system !== "string"
    || typeof session.workspaceDirectory !== "string" || !Array.isArray(session.messages)) {
    throw new Error("현재 세션 형식이 아닙니다. 새 세션으로 시작해 주세요.");
  }
  return { id: session.id, workspaceDirectory: session.workspaceDirectory,
    system: session.system, messages: session.messages };
}
