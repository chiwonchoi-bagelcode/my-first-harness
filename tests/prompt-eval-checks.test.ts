import test from "node:test";
import assert from "node:assert/strict";
import { reportsVerificationGap } from "./prompt-eval-checks.ts";

test("표현이 달라도 명시적인 브라우저 미검증을 인식한다", () => {
  for (const text of ["Browser interaction was not verified.", "Browser verification has not been performed.",
    "Browser interaction and screenshot verification were not performed.", "I haven't tested the browser interaction.",
    "No browser interaction checks have been performed.", "브라우저 검증은 하지 않았습니다.", "브라우저 미검증."])
    assert.equal(reportsVerificationGap(text), true, text);
});

test("실패 없는 검증이나 미래의 검증 제안을 미검증 보고로 오인하지 않는다", () => {
  for (const text of ["Browser tests did not fail.", "All browser checks passed.", "Would you like me to verify the game?",
    "The restart test failed. Let me inspect the code.", "브라우저 검증을 마쳤습니다."])
    assert.equal(reportsVerificationGap(text), false, text);
});
