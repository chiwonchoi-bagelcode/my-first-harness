let counter = 0;

// 메모리의 카운터를 1 증가시키고 성공 메시지를 반환한다.
function counterUP() {
  counter++;

  return "successfully increased counter";
}

// 메모리에 있는 현재 카운터 값을 반환한다.
function getCounterVal() {
  return counter;
}

// 카운터 증가·조회 툴을 등록한다. 스킬 지침은 별도 SKILL.md에서 읽는다.
export function registerCounterFeature(toolManager: any) {
  toolManager.register({
    name: "counterUP",
    description: "counter값을 1 올린다.",
    parameters: { type: "object", properties: {} },
    execute: counterUP,
  });

  toolManager.register({
    name: "getCounterVal",
    description: "counter값을 받아온다.",
    parameters: { type: "object", properties: {} },
    execute: getCounterVal,
  });
}
