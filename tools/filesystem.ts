import { readFile, readdir, writeFile } from "node:fs/promises";
import { loadImage } from "../image-content.ts";

// 지정한 폴더의 파일·폴더 이름을 줄바꿈으로 연결해 반환한다.
async function listDirectory(path: string) {
  const files = await readdir(path);

  return files.join("\n");
}

// UTF-8 텍스트 파일을 생성하거나 덮어쓰고 작성한 경로를 알린다.
async function writeTextFile(path: string, content: string) {
  await writeFile(path, content, "utf8");

  return `wrote ${path}`;
}

// 파일 읽기·쓰기와 폴더 목록 조회 툴을 ToolManager에 등록한다.
export function registerFilesystemTools(toolManager: any, supportsImages = false) {
  if (supportsImages) toolManager.register({
    name: "readImage",
    description: "PNG 이미지를 직접 보고 판단할 수 있도록 읽는다. 스크린샷도 가능하다. 4 MiB 이하, 가로·세로 각각 4096px 이하만 지원한다.",
    parameters: { type: "object", properties: { path: { type: "string", description: "읽을 PNG 이미지 경로" } }, required: ["path"] },
    // 이미지 자체를 반환한다. 별도의 LLM 분석 요청은 하지 않는다.
    execute: async ({ path }: { path: string }) => [await loadImage(path)],
  });
  toolManager.register({
    name: "readTextFile",
    description: "텍스트 파일의 내용을 읽는다.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "읽을 파일 경로",
        },
      },
      required: ["path"],
    },
    // 전달받은 경로의 파일을 UTF-8 문자열로 읽는다.
    execute: (arguments_: any) => readFile(arguments_.path, "utf8"),
  });

  toolManager.register({
    name: "listDirectory",
    description: "폴더 안의 파일과 폴더 목록을 확인한다.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "확인할 폴더 경로",
        },
      },
      required: ["path"],
    },
    // 전달받은 경로로 폴더 목록 조회 함수를 호출한다.
    execute: (arguments_: any) => listDirectory(arguments_.path),
  });

  toolManager.register({
    name: "writeTextFile",
    description: "텍스트 파일을 생성하거나 기존 내용을 덮어쓴다.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "작성할 파일 경로",
        },
        content: {
          type: "string",
          description: "파일에 작성할 전체 내용",
        },
      },
      required: ["path", "content"],
    },
    // 전달받은 경로와 내용으로 파일 작성 함수를 호출한다.
    execute: (arguments_: any) =>
      writeTextFile(arguments_.path, arguments_.content),
  });
}
