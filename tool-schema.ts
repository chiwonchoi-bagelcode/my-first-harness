import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const draft7 = new Ajv();
const draft2020 = new Ajv2020();

export function validateToolArguments(schema: any, args: unknown): string | undefined {
  // 예: Filesystem은 draft-07, Cloudflare는 2020-12를 명시한다.
  const validator = schema.$schema?.includes("/2020-12/") ? draft2020 : draft7;
  try {
    if (!validator.validate(schema, args)) {
      return `툴 인자 오류: ${validator.errorsText()}`;
    }
  } catch (error) {
    return `툴 스키마 오류: ${error instanceof Error ? error.message : error}`;
  }
}
