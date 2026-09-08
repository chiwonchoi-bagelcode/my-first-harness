import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessPaths } from "./harness-paths.ts";

// 관리 화면의 네 가지 활성화 설정을 구분한다.
export type ExtensionKind = "skills" | "tools" | "plugins" | "mcp";
// 설정이 없는 항목은 기본 활성화하며 명시한 항목만 파일에 남긴다.
export type ExtensionSettings = Record<ExtensionKind, Record<string, boolean>>;
export const EXTENSION_KINDS: ExtensionKind[] = ["skills", "tools", "plugins", "mcp"];

// 프로젝트 설정 안의 extensions만 읽고 다른 설정 필드는 보존한다.
export async function readExtensionSettings(paths: HarnessPaths) {
  const path = join(paths.projectHarnessDirectory, "settings.json");
  let document: Record<string, unknown>;
  try { document = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    document = {};
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("settings.json은 객체여야 합니다.");
  const source = document.extensions ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("extensions 설정은 객체여야 합니다.");
  const settings = {} as ExtensionSettings;
  for (const kind of EXTENSION_KINDS) {
    const values = (source as Record<string, unknown>)[kind] ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((value) => typeof value !== "boolean")) {
      throw new Error(`extensions.${kind}는 이름과 boolean 값의 객체여야 합니다.`);
    }
    settings[kind] = { ...values } as Record<string, boolean>;
  }
  return { path, document, settings };
}

// 임시 파일을 같은 폴더에 쓴 뒤 교체해 중간에 잘린 JSON이 남지 않게 한다.
export async function writeExtensionSettings(path: string, document: Record<string, unknown>, settings: ExtensionSettings) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...document, extensions: settings }, null, 2) + "\n");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
