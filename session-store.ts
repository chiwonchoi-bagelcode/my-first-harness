import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";
import type { Session } from "./session.ts";
import { checkSessionId } from "./execution-history.ts";
import { textOf } from "./llm-types.ts";

// 세션 선택 화면에 필요한 ID·첫 사용자 메시지·마지막 저장 시각이다.
export type SessionSummary = { id: string; title: string; updatedAt: number };

// 현재 프로젝트의 스냅샷만 최신 저장 순으로 나열하며 손상된 파일 수를 함께 알린다.
export async function listSessions(paths: HarnessPaths) {
  let files: string[];
  try { files = await readdir(paths.sessionDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], skippedFiles: 0 };
    throw error;
  }
  const sessions: SessionSummary[] = [];
  let skippedFiles = 0;
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const session = await loadSession(file.slice(0, -5), paths);
      const title = session.messages.filter((message) => message.role === "user")
        .map(textOf).find((text) => text.trim()) ?? (session.messages.length ? "요약된 대화 또는 이미지 대화" : "아직 메시지 없음");
      const info = await stat(join(paths.sessionDirectory, file));
      sessions.push({ id: session.id, title: title.replace(/\s+/g, " ").slice(0, 120), updatedAt: info.mtimeMs });
    } catch { skippedFiles++; }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { sessions, skippedFiles };
}

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
