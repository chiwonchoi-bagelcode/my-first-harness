import { randomUUID } from "node:crypto";
import type { Message } from "./llm-types.ts";

// resume에 필요한 현재 상태만 담는다. 원문·실행 이력은 별도 JSONL에 저장한다.
export type Session = {
  id: string;
  workspaceDirectory: string;
  system: string;
  messages: Message[];
};

// 새 ID와 기본 시스템 지침을 가진 빈 세션을 만든다.
export function createSession(workspaceDirectory: string): Session {
  return {
    id: randomUUID(),
    workspaceDirectory,
    // DSH text-turn 프롬프트에서 현재 하네스가 지원하는 역할·툴 안내만 가져온다.
    system: `You are an AI agent powered by My First Harness.

You are a coding assistant.

Verify your work by running the code or tests. Keep answers brief and factual.

Check the output and errors on every runCommand result; investigate failures before moving on.

Use the readTextFile tool — not shell commands like cat — to inspect text files.

Use the writeTextFile tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first.
`,
    messages: [],
  };
}
