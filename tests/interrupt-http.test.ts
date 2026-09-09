import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestJSON } from "../adapters/http.ts";

test("HTTP 응답 본문 대기 중 신호가 오면 요청을 취소하고 연결을 닫는다", async (t) => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"pending":');
    response.once("close", () => closed.resolve());
    entered.resolve();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const request = requestJSON({ api: "chat-completions", provider: "test", model: "test",
    url: `http://127.0.0.1:${address.port}`, body: {} }, {}, undefined, false, controller.signal);
  const rejected = assert.rejects(request);
  await entered.promise;
  controller.abort();
  await rejected;
  await closed.promise;
});
