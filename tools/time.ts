function getCurrentTime() {
  return new Date().toISOString();
}

export function registerTimeTools(toolManager: any) {
  toolManager.register({
    name: "getCurrentTime",
    description: "현재 시간을 받는다",
    parameters: {},
    execute: getCurrentTime,
  });
}
