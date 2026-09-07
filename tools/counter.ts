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

// 카운터 증가·조회 툴과 변경 전후 값을 확인하는 스킬을 함께 등록한다.
export function registerCounterFeature(toolManager: any, skillManager: any) {
  toolManager.register({
    name: "counterUP",
    description: "counter값을 1 올린다.",
    parameters: {},
    execute: counterUP,
  });

  toolManager.register({
    name: "getCounterVal",
    description: "counter값을 받아온다.",
    parameters: {},
    execute: getCounterVal,
  });

  skillManager.register({
    name: "counter-check",
    instructions:
      "카운터를 변경하기 전에 getCounterVal로 기존 값을 확인하고, 변경 후 다시 getCounterVal로 최종 값을 확인한다.",
  });
}
