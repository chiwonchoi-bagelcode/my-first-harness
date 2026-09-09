import { randomUUID } from "node:crypto";
import type { Message } from "./llm-types.ts";
import { readProjectInstructions } from "./project-instructions.ts";
import { BASE_SYSTEM_PROMPT } from "./prompts.ts";

// resume에 필요한 현재 상태만 담는다. 원문·실행 이력은 별도 JSONL에 저장한다.
export type Session = {
  id: string;
  workspaceDirectory: string;
  system: string;
  projectInstructions: string;
  discoveredTools: string[];
  messages: Message[];
};

// 새 ID와 기본 시스템 지침을 가진 빈 세션을 만든다.
export function createSession(workspaceDirectory: string): Session {
  return {
    id: randomUUID(),
    workspaceDirectory,
    projectInstructions: readProjectInstructions(workspaceDirectory),
    discoveredTools: [],
    system: BASE_SYSTEM_PROMPT,
    messages: [],
  };
}
