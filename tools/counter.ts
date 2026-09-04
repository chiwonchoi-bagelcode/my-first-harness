let counter = 0;

function counterUP() {
  counter++;

  return "successfully increased counter";
}

function getCounterVal() {
  return counter;
}

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
