import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 产出可安装的插件目录。
 *
 * 市场来源指向 stage/zcode-task-scheduler，安装时 ZCode 只拷贝这一份，
 * 不会把源码仓的 node_modules 一起带进插件缓存。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = join(root, "stage");
const target = join(stageRoot, "zcode-task-scheduler");

const INCLUDE = [
  [".zcode-plugin", ".zcode-plugin"],
  ["dist", "dist"],
  ["skills", "skills"],
  ["commands", "commands"],
];

async function main() {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const [from, to] of INCLUDE) {
    await cp(join(root, from), join(target, to), { recursive: true });
  }

  const marketplace = {
    name: "zcode-task-scheduler-local",
    plugins: [
      {
        name: "zcode-task-scheduler",
        source: "./zcode-task-scheduler",
        version: "0.1.0",
        description: "任务调度：给已有会话或新会话预定任务，到点限流执行，失败在原会话续跑",
        displayName: "任务调度",
        displayName_i18n: {
          "zh-CN": "任务调度",
          "en-US": "Task Scheduler",
        },
        description_i18n: {
          "zh-CN":
            "任务调度：给已有会话或新会话预定任务，到点限流执行，失败在原会话续跑",
          "en-US":
            "Schedule tasks for existing or new sessions, run them with rate limits, and continue failed runs inside the same session",
        },
        category: "productivity",
      },
    ],
  };
  await writeFile(join(stageRoot, "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);

  console.log(`已产出可安装目录：${stageRoot}`);
}

await main();
