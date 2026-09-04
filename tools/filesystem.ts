import { readFile, readdir, writeFile } from "node:fs/promises";

async function listDirectory(path: string) {
  const files = await readdir(path);

  return files.join("\n");
}

async function writeTextFile(path: string, content: string) {
  await writeFile(path, content, "utf8");

  return `wrote ${path}`;
}

export function registerFilesystemTools(toolManager: any) {
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
    execute: (arguments_: any) =>
      writeTextFile(arguments_.path, arguments_.content),
  });
}
