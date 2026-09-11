import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "../tool-schema.ts";
import type { HarnessPaths } from "../harness-paths.ts";
import type { HarnessPlugin } from "../plugin-manager.ts";
import type { RegisteredTool, ToolRegistrar } from "../tool-manager.ts";

// 모델이 만든 툴을 실행하는 고정 실행기와 이 플러그인이 소유한 스킬의 경로다.
const RUNNER_PATH = fileURLToPath(new URL("../custom-tools/runner.mjs", import.meta.url));
const SKILL_PATH = fileURLToPath(new URL("../custom-tools/skills/tool-making/SKILL.md", import.meta.url));

export const CUSTOM_TOOLS_PLUGIN_NAME = "custom-tools";
const NAME_PATTERN = "^[a-z][A-Za-z0-9_]{0,39}$";
const RESERVED_NAMES = new Set(["createTool", "deleteTool", "ToolSearch"]);
const MAX_CODE_CHARS = 65_536;
const MAX_RESULT_CHARS = 16_384;
const MAX_STDERR_CHARS = 4_096;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
// 실행기가 결과 JSON 앞에 붙이는 표식. 툴 코드가 표준 출력에 찍은 내용은 표식 앞에 남아 무시된다.
const RESULT_MARKER = "\n__HARNESS_TOOL_RESULT__\n";

// 디스크에 저장하는 툴 메타데이터다. 코드는 같은 폴더의 index.mjs에 있다.
type SavedTool = {
  version: 1; name: string; description: string; parameters: Record<string, unknown>; timeoutMs: number;
  // 참이면 프로젝트 폴더에 저장되어 다음 실행에도 등록된다. 기본은 세션 전용이다.
  persist: boolean; createdAt: string; updatedAt: string;
};

// 외부 값을 필드 조회 가능한 객체로 좁힌다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// persist: true로 만든 툴이 저장되는 프로젝트 폴더다. 여기 있는 툴만 다음 실행에 다시 등록된다.
export function customToolsDirectory(paths: HarnessPaths) {
  return join(paths.projectHarnessDirectory, "tools");
}

// 세션 전용(기본) 툴이 놓이는 임시 폴더다. 프로세스마다 다르고 플러그인이 꺼질 때 지운다. 코드 원문은 세션 JSONL의 createTool 호출에 남는다.
export function ephemeralToolsDirectory() {
  return join(tmpdir(), "my-first-harness-custom-tools", String(process.pid));
}

// 인자 스키마가 객체형이고 컴파일되는지 확인한다. 빈 객체를 검증해 스키마 자체의 오류만 걸러낸다(필수 인자 누락은 정상이다).
function schemaProblem(parameters: unknown): string | undefined {
  if (!isObject(parameters) || parameters.type !== "object") return "parameters는 type이 \"object\"인 JSON 스키마 객체여야 합니다.";
  const problem = validateToolArguments(parameters, {});
  return problem?.startsWith("툴 스키마 오류") ? problem : undefined;
}

// 실행 결과를 툴 결과 문자열로 만든다. 길면 앞부분만 남기고 잘렸다고 표시한다.
function formatResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[${text.length - MAX_RESULT_CHARS}자 잘림 — 결과를 더 작게 돌려주도록 툴을 고치세요]`;
}

// 툴 코드를 자식 프로세스에서 실행한다. 하네스의 환경 변수(API 키 포함)는 넘기지 않고, 시간 제한과 중단 신호로 죽인다.
export function runCustomTool(options: { toolDirectory: string; workspaceDirectory: string; args: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, options.toolDirectory], {
      cwd: options.workspaceDirectory,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "C.UTF-8",
        TOOL_DIR: options.toolDirectory, WORKSPACE_DIR: options.workspaceDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    const onAbort = () => { aborted = true; child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (action: () => void) => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); action(); };
    // spawn의 ENOENT는 node 실행 파일뿐 아니라 작업 폴더가 없을 때도 나온다.
    child.once("error", (error) => finish(() => reject(new Error(`툴 실행기를 시작할 수 없습니다: ${error.message}${(error as NodeJS.ErrnoException).code === "ENOENT" ? ` (작업 폴더 ${options.workspaceDirectory}가 없거나 node를 찾지 못했습니다)` : ""}`))));
    child.once("close", (code) => finish(() => {
      const tail = stderr.trim() ? `\nstderr: ${stderr.trim()}` : "";
      if (aborted) return reject(new Error("사용자 요청으로 툴 실행을 중단했습니다."));
      if (timedOut) {
        return reject(new Error(`툴 실행이 ${options.timeoutMs}ms 안에 끝나지 않아 중단했습니다. 무한 루프나 긴 계산을 확인하고, 필요하면 createTool(replace: true)에서 timeoutMs를 늘리세요.${tail}`));
      }
      const marker = stdout.lastIndexOf(RESULT_MARKER);
      let parsed: unknown;
      try { parsed = JSON.parse(stdout.slice(marker + RESULT_MARKER.length).trim()); } catch {
        if (marker < 0) return reject(new Error(`툴 실행기가 결과를 내지 못했습니다(종료 코드 ${code}). 프로세스가 중간에 종료됐는지(process.exit 호출 등) 확인하세요.${tail}`));
        return reject(new Error(`툴 실행기 출력을 해석할 수 없습니다(종료 코드 ${code}).${tail}`));
      }
      if (!isObject(parsed) || typeof parsed.ok !== "boolean") return reject(new Error(`툴 실행기 출력 형식이 잘못되었습니다(종료 코드 ${code}).${tail}`));
      if (!parsed.ok) return reject(new Error(`툴 코드가 실패했습니다: ${String(parsed.error)}${tail}\n코드를 고쳐 createTool(replace: true)로 다시 등록하세요.`));
      resolve(formatResult(parsed.result));
    }));
    // 자식이 먼저 죽으면 stdin 쓰기가 EPIPE로 실패할 수 있다. close 처리에서 이미 보고한다.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(options.args ?? {}));
  });
}

// 모델이 실행 중에 툴을 만들고(createTool) 지우는(deleteTool) 플러그인이다. 만든 툴은 프로젝트 폴더에 저장되어 다음 실행에도 등록된다.
// 하네스는 툴의 내용을 모른다. 코드·스키마·설명은 전부 모델이 쓰고, 실행은 격리된 자식 프로세스에서 한다.
export function createCustomToolsPlugin(paths: HarnessPaths): HarnessPlugin {
  const persistentDirectory = customToolsDirectory(paths);
  const ephemeralDirectory = ephemeralToolsDirectory();
  // 등록된 툴의 해제 함수와 저장 위치. 지우기·교체·정리에 쓴다.
  const registered = new Map<string, { unregister: () => void; directory: string; persist: boolean }>();
  let registrar: ToolRegistrar | undefined;

  function toolDirectory(name: string, persist: boolean) { return join(persist ? persistentDirectory : ephemeralDirectory, name); }

  // 저장된 메타데이터를 툴 정의로 만든다. 실행은 매번 새 자식 프로세스다.
  function definitionOf(saved: SavedTool): RegisteredTool {
    return {
      name: saved.name, description: saved.description, parameters: saved.parameters,
      execute: (args: unknown, context?: { signal?: AbortSignal }) => runCustomTool({
        toolDirectory: toolDirectory(saved.name, saved.persist), workspaceDirectory: paths.workspaceDirectory, args, timeoutMs: saved.timeoutMs, signal: context?.signal,
      }),
    };
  }

  // 플러그인이 켜져 있을 때만 등록한다. 등록 해제 함수는 지우기와 교체에 쓴다.
  function register(saved: SavedTool) {
    if (!registrar) throw new Error("custom-tools 플러그인이 꺼져 있어 툴을 등록할 수 없습니다.");
    registered.set(saved.name, { unregister: registrar.register(definitionOf(saved)), directory: toolDirectory(saved.name, saved.persist), persist: saved.persist });
  }

  // 프로젝트 폴더의 tool.json을 읽어 영구 저장된 툴 목록을 만든다. 손상된 항목은 건너뛰고 경고만 남긴다.
  async function loadSaved(): Promise<SavedTool[]> {
    const entries = await readdir(persistentDirectory, { withFileTypes: true }).catch(() => []);
    const saved: SavedTool[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta: unknown = JSON.parse(await readFile(join(persistentDirectory, entry.name, "tool.json"), "utf8"));
        if (!isObject(meta) || meta.name !== entry.name || typeof meta.description !== "string" || schemaProblem(meta.parameters)) {
          throw new Error("tool.json 형식이 맞지 않습니다.");
        }
        saved.push({
          version: 1, name: entry.name, description: meta.description, parameters: meta.parameters as Record<string, unknown>,
          timeoutMs: typeof meta.timeoutMs === "number" ? meta.timeoutMs : DEFAULT_TIMEOUT_MS, persist: true,
          createdAt: String(meta.createdAt ?? ""), updatedAt: String(meta.updatedAt ?? ""),
        });
      } catch (error) {
        console.warn(`[custom-tools] ${entry.name}: 불러오지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return saved;
  }

  return {
    name: CUSTOM_TOOLS_PLUGIN_NAME,
    description: "모델이 직접 만드는 툴. 작업 폴더의 .my-first-harness/tools/에 저장되어 다음 실행에도 남습니다.",
    skills: [SKILL_PATH],
    async setup(tools) {
      registrar = tools;
      const saved = await loadSaved();
      for (const tool of saved) {
        try { register(tool); }
        catch (error) { console.warn(`[custom-tools] ${tool.name}: 등록하지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`); }
      }
      // 이전 실행에서 남긴 툴이 있으면 시작 때 알려 사용자가 알고 쓰거나 지울 수 있게 한다.
      if (saved.length) console.log(`[custom-tools] 저장된 툴 ${saved.length}개 등록: ${saved.map((tool) => tool.name).join(", ")} (지우려면 deleteTool)`);

      tools.register({
        name: "createTool",
        description: "네가 쓸 툴을 직접 만든다. JavaScript 코드(index.mjs 전체, `export default async function run(args) { ... }`)와 인자 JSON 스키마를 주면 프로젝트 폴더에 저장하고 곧바로 일반 툴로 등록해 다음 스텝부터 부를 수 있다. 같은 결정론적 계산을 여러 번 해야 할 때(후보 채점, 규칙 시뮬레이션, 형식 변환) 쓴다. 코드는 격리된 프로세스에서 표준 라이브러리만으로 실행되며 하네스의 환경 변수를 보지 못한다. 만든 뒤에는 예시 인자로 한 번 실행해 확인하라. 자세한 절차는 tool-making 스킬에 있다.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", pattern: NAME_PATTERN, description: "툴 이름. 소문자로 시작하는 영문·숫자·밑줄, 40자 이하. 기존 툴과 겹치면 안 된다." },
            description: { type: "string", minLength: 1, maxLength: 2000, description: "이 툴이 무엇을 계산하고 무엇을 돌려주는지. 나중의 네가 읽는 설명이다." },
            parameters: { type: "object", description: "인자 JSON 스키마. type은 object여야 하며 properties와 required를 적는다. 호출 때 하네스가 이 스키마로 인자를 검증한다." },
            code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "index.mjs 전체 내용. ES 모듈, default export가 async 함수여야 한다. 반환값이 결과가 된다(문자열 또는 JSON 직렬화 가능한 값)." },
            timeoutMs: { type: "integer", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, description: "실행 시간 제한(ms). 기본 30000." },
            replace: { type: "boolean", description: "true면 같은 이름의 기존 툴을 이 내용으로 교체한다." },
            persist: { type: "boolean", description: "true면 프로젝트 폴더에 저장해 다음 세션에도 등록한다. 기본 false: 이 세션에서만 쓰고 하네스가 끝나면 사라진다. 사용자가 남기라고 했을 때만 켠다." },
          },
          required: ["name", "description", "parameters", "code"],
          additionalProperties: false,
        },
        // 검사 → 기존 등록 해제(교체) → 저장 → 등록. 등록이 실패하면 저장한 폴더를 되돌린다.
        async execute({ name, description, parameters, code, timeoutMs = DEFAULT_TIMEOUT_MS, replace = false, persist = false }:
          { name: string; description: string; parameters: Record<string, unknown>; code: string; timeoutMs?: number; replace?: boolean; persist?: boolean }) {
          if (RESERVED_NAMES.has(name)) throw new Error(`${name}은(는) 예약된 이름입니다. 다른 이름을 쓰세요.`);
          const problem = schemaProblem(parameters);
          if (problem) throw new Error(problem);
          if (!/export\s+default/.test(code)) throw new Error("code에 default export가 없습니다. `export default async function run(args) { ... }` 형태로 작성하세요.");
          const existing = registered.get(name);
          if (existing && !replace) throw new Error(`이미 있는 툴입니다: ${name}. 고치려면 replace: true로 다시 부르고, 다른 툴이면 이름을 바꾸세요.`);
          const directory = toolDirectory(name, persist);
          let previous: Partial<SavedTool> | undefined;
          if (existing) {
            try { previous = JSON.parse(await readFile(join(existing.directory, "tool.json"), "utf8")); } catch { previous = undefined; }
            existing.unregister();
            registered.delete(name);
            // 세션 전용과 영구 저장 사이를 옮기면 옛 폴더는 지운다.
            if (existing.directory !== directory) await rm(existing.directory, { recursive: true, force: true });
          }
          const now = new Date().toISOString();
          const saved: SavedTool = { version: 1, name, description, parameters, timeoutMs, persist, createdAt: previous?.createdAt || now, updatedAt: now };
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "index.mjs"), code);
          await writeFile(join(directory, "tool.json"), JSON.stringify(saved, null, 2) + "\n");
          try { register(saved); }
          catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw new Error(`툴을 등록할 수 없습니다: ${error instanceof Error ? error.message : String(error)} 다른 이름을 쓰세요.`);
          }
          return JSON.stringify({
            name, path: directory, timeoutMs, persist, replaced: Boolean(existing),
            note: (persist ? "프로젝트 폴더에 저장되어 다음 세션에도 등록됩니다. " : "이 세션에서만 쓸 수 있고 하네스가 끝나면 사라집니다. ")
              + "다음 스텝부터 이 툴을 부를 수 있습니다. 실제 작업에 쓰기 전에 예시 인자로 한 번 실행해 결과를 확인하세요.",
          });
        },
      });

      tools.register({
        name: "deleteTool",
        description: "createTool로 만든 툴을 등록 해제하고 저장 폴더를 지운다.",
        parameters: { type: "object", properties: { name: { type: "string", pattern: NAME_PATTERN } }, required: ["name"], additionalProperties: false },
        // 등록을 풀고 폴더를 지운다. 모델이 만든 툴이 아니면 거절한다.
        async execute({ name }: { name: string }) {
          const entry = registered.get(name);
          if (!entry) {
            throw new Error(`모델이 만든 툴 중에 ${name}이(가) 없습니다. 현재 목록: ${[...registered.keys()].join(", ") || "(없음)"}`);
          }
          entry.unregister();
          registered.delete(name);
          await rm(entry.directory, { recursive: true, force: true });
          return `${name} 툴을 지웠습니다.`;
        },
      });

      // 플러그인을 끄면 등록은 관리자가 해제한다. 여기서는 내부 상태를 비우고 세션 전용 툴의 임시 폴더를 지운다.
      return async () => { registered.clear(); registrar = undefined; await rm(ephemeralDirectory, { recursive: true, force: true }); };
    },
  };
}
