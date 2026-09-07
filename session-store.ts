import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";
import type { Message } from "./llm-types.ts";

// 세션 ID, 작업 폴더, 시스템 지침과 원문·요청용 대화 기록.
export type Session = {
  id: string;
  workspaceDirectory: string;
  system: string;
  history: Message[];
  messages: Message[];
};

// 저장 폴더를 준비하고 세션 전체를 ID별 JSON 파일에 저장한다.
export async function saveSession(session: Session, paths: HarnessPaths) {
  const { sessionDirectory } = paths;
  await mkdir(sessionDirectory, { recursive: true });

  await writeFile(
    join(sessionDirectory, `${session.id}.json`),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

// ID에 해당하는 세션 JSON을 읽고 현재 형식인지 확인해 반환한다.
export async function loadSession(id: string, paths: HarnessPaths): Promise<Session> {
  const content = await readFile(join(paths.sessionDirectory, `${id}.json`), "utf8");

  const session = JSON.parse(content);
  if (typeof session.system !== "string") {
    throw new Error("현재 세션 형식이 아닙니다. 새 세션으로 시작해 주세요.");
  }
  return session;
}
