// Reports the static JS closure needed by the default dictation route.
// Usage: node scripts/report-dictation-bundle.mjs <report.json>
import { build } from "vite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const destination = process.argv[2];
if (!destination) throw new Error("Supply a report JSON path");
await build({
  root: resolve("src"),
  configFile: resolve("src/vite.config.mjs"),
  logLevel: "error",
  plugins: [
    {
      name: "report-dictation-bundle",
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const roots = chunks.filter(
          (chunk) =>
            chunk.isEntry ||
            Object.keys(chunk.modules).some((id) =>
              /\/src\/(App|DictationApp)\.jsx$/.test(id.replaceAll("\\", "/"))
            )
        );
        const loaded = new Set();
        const visit = (chunk) => {
          if (!chunk || loaded.has(chunk)) return;
          loaded.add(chunk);
          chunk.imports.forEach((id) => visit(bundle[id]));
        };
        roots.forEach(visit);
        const modules = [...new Set([...loaded].flatMap((chunk) => Object.keys(chunk.modules)))];
        const sourcePath = (id) =>
          id.replaceAll("\\", "/").replace(resolve(".").replaceAll("\\", "/") + "/", "");
        const allIds = [...this.getModuleIds()];
        const starts = allIds.filter((id) =>
          /\/src\/(main|DictationApp)\.jsx$/.test(id.replaceAll("\\", "/"))
        );
        const shortestPath = (suffix) => {
          const queue = starts.map((id) => [id]);
          const visited = new Set();
          for (let i = 0; i < queue.length; i++) {
            const path = queue[i];
            const id = path.at(-1);
            if (visited.has(id)) continue;
            visited.add(id);
            if (sourcePath(id).endsWith("/" + suffix)) return path.map(sourcePath);
            for (const next of this.getModuleInfo(id)?.importedIds ?? [])
              queue.push([...path, next]);
          }
          return null;
        };
        const report = {
          javascriptBytes: [...loaded].reduce(
            (total, chunk) => total + Buffer.byteLength(chunk.code),
            0
          ),
          gzipBytes: [...loaded].reduce((total, chunk) => total + gzipSync(chunk.code).length, 0),
          chunks: [...loaded].map((chunk) => chunk.fileName).sort(),
          eagerPaths: Object.fromEntries(
            ["ReasoningService.ts", "SyncService.ts", "useAuth.ts", "chatTurnEngine.ts"].map(
              (suffix) => [suffix, shortestPath(suffix)]
            )
          ),
          modules: modules
            .map((id) =>
              id.replaceAll("\\", "/").replace(resolve(".").replaceAll("\\", "/") + "/", "")
            )
            .sort(),
        };
        writeFileSync(destination, JSON.stringify(report, null, 2));
        if (process.argv.includes("--check")) {
          const forbidden = report.modules.filter(
            (id) =>
              /\/(ReasoningService|SyncService|useAuth|chatTurnEngine|noteStore)\.[jt]s$/.test(
                id
              ) ||
              /node_modules\/@ai-sdk\//.test(id) ||
              /src\/locales\/(?!en\/)[^/]+\//.test(id)
          );
          if (forbidden.length)
            throw new Error(`Heavy modules loaded by dictation: ${forbidden.join(", ")}`);
        }
        console.log(
          JSON.stringify({
            javascriptBytes: report.javascriptBytes,
            gzipBytes: report.gzipBytes,
            modules: modules.length,
          })
        );
      },
    },
  ],
});
