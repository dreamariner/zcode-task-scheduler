import { build, context } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

/** 打包后的产物不依赖 node_modules，插件安装目录里只需要 dist。 */
const banner = {
  js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
};

async function buildNode(entry, outfile) {
  return build({
    entryPoints: [join(root, entry)],
    outfile: join(dist, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner,
    sourcemap: false,
    logLevel: "info",
  });
}

async function buildUi() {
  await build({
    entryPoints: [join(root, "src/ui/main.tsx")],
    outfile: join(dist, "ui/app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    sourcemap: false,
    logLevel: "info",
  });

  const [template, css, script] = await Promise.all([
    readFile(join(root, "src/ui/panel.html"), "utf8"),
    readFile(join(root, "src/ui/styles.css"), "utf8"),
    readFile(join(dist, "ui/app.js"), "utf8"),
  ]);

  const html = template
    .replace("/*__STYLE__*/", () => css)
    .replace("/*__SCRIPT__*/", () => script);

  await writeFile(join(dist, "ui/panel.html"), html);
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "ui"), { recursive: true });

  if (watch) {
    const ctx = await context({
      entryPoints: [join(root, "src/server/entry.ts")],
      outfile: join(dist, "server.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner,
      logLevel: "info",
    });
    await ctx.watch();
    console.log("watch 模式已启动");
    return;
  }

  await buildNode("src/server/entry.ts", "server.mjs");
  await buildNode("src/daemon/entry.ts", "daemon.mjs");
  await buildUi();
  console.log(`构建完成：${dist}`);
}

await main();
