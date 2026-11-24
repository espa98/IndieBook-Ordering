import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errorBody, type AppRequest, type AppResponse } from "./app";

export type HttpServerOptions = {
  /** 요청 본문 상한(바이트). 기본 1 MiB. 넘으면 413 */
  maxBodyBytes?: number;
  /** 요청 전체를 받는 데 허용하는 시간(ms). 기본 15초 */
  requestTimeoutMs?: number;
};

const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function send(res: ServerResponse, requestId: string, response: AppResponse): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-request-id": requestId,
    ...SECURITY_HEADERS,
    ...(response.headers ?? {}),
  });
  res.end(payload);
}

/** 본문을 상한까지만 모은다. 상한을 넘으면 나머지는 버리고 끝난 뒤 413으로 응답한다(연결을 끊지 않아 클라이언트가 응답을 읽을 수 있다) */
function readBody(req: IncomingMessage, maxBytes: number): Promise<{ text: string | undefined; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve({ text: tooLarge || size === 0 ? undefined : Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
  });
}

/** 앱을 `node:http` 서버로 감싼다. 프레임워크 없이 본문 상한·보안 헤더·요청 ID만 더한다. */
export function createHttpServer(app: (request: AppRequest) => Promise<AppResponse>, options: HttpServerOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { text, tooLarge } = await readBody(req, maxBodyBytes);
      if (tooLarge) {
        send(res, requestId, { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large") });
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const response = await app({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers, rawBody: text });
      send(res, requestId, response);
    } catch {
      // 앱은 오류를 응답으로 바꾸므로 여기는 서버 자체의 문제다. 내부 정보는 싣지 않는다
      if (!res.headersSent) send(res, requestId, { status: 500, body: errorBody("INTERNAL_ERROR", "Internal server error") });
      else res.end();
    }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 15_000;
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
  return server;
}
