// 현재 시각을 UTC 기준 ISO 문자열로 반환한다.
function getCurrentTime() {
  return new Date().toISOString();
}

// 현재 시각 조회 툴을 ToolManager에 등록한다.
export function registerTimeTools(toolManager: any) {
  toolManager.register({
    name: "getCurrentTime",
    description: "현재 시간을 받는다",
    parameters: {},
    execute: getCurrentTime,
  });
}
