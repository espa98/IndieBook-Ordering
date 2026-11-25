import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 서버를 의존성까지 포함한 단일 ESM 파일로 묶는다(E8). 실행에는 Node.js만 필요하다.
 * `pg-native`는 선택 의존성이라 제외한다. 번들은 소스맵·시험용 값·개발 의존성을 담지 않는다.
 */
async function bundle(entry: string, outFile: string): Promise<void> {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["pg-native"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    // CommonJS 의존성(pg)이 내장 모듈을 require로 불러오므로 ESM 번들에 require를 제공한다
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  });
}

export const buildServer = (outFile: string) => bundle("server/main.ts", outFile);
/** 마이그레이션 적용 도구(`server/migrate.ts`)도 같은 방식으로 단일 파일로 묶는다 */
export const buildMigrate = (outFile: string) => bundle("server/migrate.ts", outFile);

// `node server/build.ts [출력 파일] [server|migrate]`로 직접 실행하면 dist/server.mjs(또는 지정한 파일)를 만든다
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(process.argv[2] ?? resolve(root, "dist/server.mjs"));
  await (process.argv[3] === "migrate" ? buildMigrate(out) : buildServer(out));
  console.log(`built ${out}`);
}
