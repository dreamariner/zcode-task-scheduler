import { spawn } from "node:child_process";
import { runDaemon } from "./main.js";

/**
 * 启动角色：launcher 还是 daemon。
 *
 * 宿主回收会话级 MCP server 时，会按 PPID 树把整棵子树干掉（先 SIGINT，再 SIGTERM，
 * 最后 SIGKILL）。插件 MCP server 是会话级短命进程，调度器若直接挂在它下面，
 * 宿主一回收就连带把调度器杀掉，当夜就没人干活了。
 *
 * 破解办法是两次 fork：中转进程拉起真正的调度器后立刻退出，调度器于是被 init 收养
 * （PPID 变成 1），不再出现在 MCP server 的子树里，宿主按树清理时碰不到它。
 */
const ROLE = process.env.ZCODE_DAEMON_ROLE ?? "daemon";

if (ROLE === "launcher") {
  const entry = process.argv[1];
  if (!entry) {
    process.stderr.write("[zcode-task-scheduler] 找不到 daemon 入口脚本\n");
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ZCODE_DAEMON_ROLE: "daemon" },
  });
  child.unref();
  process.exit(0);
} else {
  await runDaemon();
}
