let counter = 0;

function counterUP() {
  counter++;

  return "successfully increased counter";
}

function getCounterVal() {
  return counter;
}

export function registerCounterTools(toolManager: any) {
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
}
