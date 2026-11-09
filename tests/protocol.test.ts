import { expect, test } from "bun:test";
import { readEvents, readObject } from "../protocol";

function response(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(output) {
    if (offset >= bytes.length) return output.close();
    output.enqueue(bytes.slice(offset, offset + size));
    offset += size;
  } }));
}
async function events(text: string, size = 1) {
  const result = [];
  for await (const event of readEvents(response(text, size))) result.push(event);
  return result;
}

test("SSE 解码跨字节 UTF-8、CRLF、多行 data 与无换行尾帧", async () => {
  expect(await events(': comment\r\nevent: ping\r\ndata: heartbeat\r\n\r\ndata: {\r\ndata: "text":"好😀"}\r\n\r\nevent: final\ndata: 尾帧')).toEqual([
    { event: "ping", data: "heartbeat" }, { event: "", data: '{\n"text":"好😀"}' }, { event: "final", data: "尾帧" },
  ]);
});

test("SSE 单事件大小受限，即使没有结束换行", async () => {
  await expect(events(`data: ${"a".repeat(1_048_577)}`, 65536)).rejects.toMatchObject({ code: "upstream_limit" });
});

test("JSON 只接受有界对象，不回显响应原文", async () => {
  expect(await readObject(response('{"ok":true,"text":"你好😀"}'))).toEqual({ ok: true, text: "你好😀" });
  for (const raw of ["PRIVATE_COOKIE", "[]", "null", '"PRIVATE_COOKIE"']) {
    await expect(readObject(response(raw))).rejects.toMatchObject({ code: "upstream_protocol", message: "上游响应不是预期的 JSON 对象。" });
  }
  await expect(readObject(response(JSON.stringify({ data: "a".repeat(1_048_577) }), 65536))).rejects.toMatchObject({ code: "upstream_limit" });
});
