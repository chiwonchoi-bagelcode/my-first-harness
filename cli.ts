import { createInterface } from "node:readline/promises";
import { createSession } from "./session.ts";
import { loadSession as restoreSession, saveSession as persistSession } from "./session-store.ts";
import { attachmentPath, checkImageInput, loadImage } from "./image-content.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { HistorySink } from "./execution-history.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { ImageBlock } from "./llm-types.ts";

// 코어 진행 이벤트를 기존 CLI 출력 형식으로 표시한다.
export function renderCliEvent(event: AgentEvent) {
  switch (event.type) {
    case "assistant-text": console.log(event.text); break;
    case "tool-start": console.log(`[tool] ${event.name} ${event.arguments}`); break;
    case "compaction-start": console.log("[context] 대화를 요약합니다..."); break;
    case "compaction-end": console.log(`[context] 압축 완료: ${event.beforeChars} → ${event.afterChars}자`); break;
    case "compaction-empty": console.log("[context] 요약할 대화가 없습니다."); break;
    case "tool-results-pruned": console.log(`[context] 툴 결과 ${event.count}개 정리: ${event.beforeChars} → ${event.afterChars}자`); break;
  }
}

// 터미널 실행에 필요한 코어와 저장·종료 함수를 받는다.
export type CliOptions = {
  agent: Agent;
  paths: HarnessPaths;
  history: HistorySink;
  supportsImages?: boolean;
  dispose: () => Promise<void>;
  saveSession?: typeof persistSession;
  loadSession?: typeof restoreSession;
};

// 사용자 명령·이미지 첨부·터미널 종료를 처리한다. 코어는 입력 장치를 알지 못한다.
export async function runCli(options: CliOptions) {
  const { agent, paths, history, supportsImages, dispose,
    saveSession = persistSession, loadSession = restoreSession } = options;

  let session = createSession(paths.workspaceDirectory);
  let pendingImages: ImageBlock[] = [];

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let cleanupPromise: Promise<void> | undefined;
  let interrupted = false;
  // 정상 종료와 중단이 겹쳐도 셸 작업과 MCP 연결을 한 번만 정리하고 실패를 알린다.
  function cleanupRuntime() {
    cleanupPromise ??= Promise.allSettled([dispose()])
      .then(async (results) => {
        await history.append({ sessionId: session.id }, { type: "session-close", reason: interrupted ? "SIGINT" : "runtime-exit" });
        await history.flush();
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "런타임 정리 실패");
      });
    return cleanupPromise;
  }
  // 터미널 Ctrl+C와 운영체제 SIGINT 모두 같은 정리를 거쳐 종료한다.
  function handleInterrupt() {
    interrupted = true;
    terminal.close();
    void cleanupRuntime().catch(console.error).finally(() => process.exit(130));
  }
  terminal.on("SIGINT", handleInterrupt);
  process.once("SIGINT", handleInterrupt);
  console.log(`session: ${session.id}`);

  try {
    await history.append({ sessionId: session.id }, { type: "session-start",
      workspaceDirectory: session.workspaceDirectory, system: session.system });
    await saveSession(session, paths);
    while (true) {
      const input = await terminal.question("> ");
      if (input.trim().startsWith("/")) {
        await history.append({ sessionId: session.id }, { type: "command", input });
      }

      if (input.trim() === "/quit") {
        break;
      }

      if (input.trim() === "/attach" || input.startsWith("/attach ")) {
        try {
          if (!supportsImages) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
          const image = await loadImage(attachmentPath(input));
          checkImageInput([...session.messages, { role: "user", content: [...pendingImages, image] }], true);
          pendingImages.push(image);
          console.log(`[attach] ${image.path} (${image.width}×${image.height}) — 다음 메시지에 첨부합니다.`);
        } catch (error) {
          console.log(`[attach] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (input.trim() === "/new") {
        session = createSession(paths.workspaceDirectory);
        pendingImages = [];
        await history.append({ sessionId: session.id }, { type: "session-start",
          workspaceDirectory: session.workspaceDirectory, system: session.system });
        await saveSession(session, paths);
        console.log(`new session: ${session.id}`);
        continue;
      }

      if (input.startsWith("/resume ")) {
        const id = input.slice("/resume ".length).trim();

        session = await loadSession(id, paths);
        pendingImages = [];
        await history.append({ sessionId: session.id }, { type: "session-resume", messageCount: session.messages.length });

        console.log(`resumed session: ${session.id}`);
        continue;
      }

      if (input.trim() === "/compact") {
        await agent.compact(session);
        continue;
      }

      const images = pendingImages;
      pendingImages = [];
      const output = await agent.turn(session, input, images);

      await saveSession(session, paths);

      console.log(output);
    }
  } catch (error) {
    // Ctrl+C로 question 또는 실행 중 명령이 취소된 오류는 중단 처리에서 마무리한다.
    if (!interrupted) throw error;
  } finally {
    terminal.close();
    await cleanupRuntime();
    process.removeListener("SIGINT", handleInterrupt);
  }
}
