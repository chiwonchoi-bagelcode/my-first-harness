// 모델이 만든 툴을 자식 프로세스에서 실행하는 고정 실행기다. 하네스가 `node runner.mjs <툴 폴더>`로 띄운다.
// 인자는 표준 입력의 JSON 하나, 결과는 표준 출력의 JSON 한 줄 {ok, result | error}. 툴 코드는 index.mjs의 default export 함수다.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// 결과는 이 표식 뒤의 JSON 한 개다. 툴 코드가 표준 출력에 무엇을 찍어도 표식 앞이라 결과를 깨뜨리지 않는다.
const RESULT_MARKER = "\n__HARNESS_TOOL_RESULT__\n";
const emit = (payload) => process.stdout.write(RESULT_MARKER + JSON.stringify(payload));
// 툴 코드의 console.log/info/debug는 stderr로 보낸다. 결과는 반환값으로만 전달한다.
console.log = console.info = console.debug = (...args) => console.error(...args);

const toolDirectory = process.argv[2];
if (!toolDirectory) {
  emit({ ok: false, error: "툴 폴더 인자가 없습니다." });
  process.exit(1);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const args = input.trim() ? JSON.parse(input) : {};
  const module = await import(pathToFileURL(join(toolDirectory, "index.mjs")).href);
  const run = module.default;
  if (typeof run !== "function") {
    throw new Error("index.mjs는 함수를 default export 해야 합니다: export default async function run(args) { ... }");
  }
  const result = await run(args);
  emit({ ok: true, result: result === undefined ? null : result });
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? (error.stack || error.message) : String(error) });
  process.exitCode = 1;
}
