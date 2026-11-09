import { createInterface } from "node:readline";

/**
 * 假的 app-server：按固定脚本回应协议请求。
 *
 * 用法：node fake-app-server.mjs <脚本文件>
 * 脚本文件是一行一个 JSON，形状为 {"method": "...", "result": {...}} 或
 * {"method": "...", "error": {"code": -1, "message": "..."}}。
 * 另外支持 {"push": {"method": "...", "params": {...}}} 这种主动推送的事件。
 */
const scriptFile = process.argv[2];
const { readFileSync } = await import("node:fs");
const script = readFileSync(scriptFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;

  if (message.method === "quit") {
    process.exit(0);
  }

  const index = script.findIndex((item) => item.method === message.method);
  if (index < 0) {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32601, message: `no fake for ${message.method}` } })}\n`,
    );
    continue;
  }
  const entry = script.splice(index, 1)[0];
  if (entry.error) {
    process.stdout.write(`${JSON.stringify({ id: message.id, error: entry.error })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: entry.result ?? {} })}\n`);
  }
  if (entry.push) {
    process.stdout.write(`${JSON.stringify(entry.push)}\n`);
  }
}
