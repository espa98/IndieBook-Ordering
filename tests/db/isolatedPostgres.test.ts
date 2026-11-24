import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startIsolatedPostgres, type IsolatedPostgres } from "../helpers/isolatedPostgres";

let db: IsolatedPostgres;
beforeAll(async () => {
  db = await startIsolatedPostgres();
}, 120_000);
afterAll(async () => {
  await db?.stop();
}, 60_000);

describe("격리 로컬 Postgres (E1)", () => {
  it("임시 폴더의 로컬 서버에 접속해 DDL을 실행하고 독립된 두 연결이 같은 데이터를 본다", async () => {
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("create table t (id int primary key, note text)");
      await a.query("insert into t values (1, 'from-a')");
      expect((await b.query("select note from t where id = 1")).rows).toEqual([{ note: "from-a" }]);
      const version = (await a.query("show server_version")).rows[0].server_version as string;
      expect(version.startsWith("17.")).toBe(true);
      const host = (await a.query("select inet_server_addr()::text as addr")).rows[0].addr as string;
      expect(host.startsWith("127.0.0.1")).toBe(true); // 로컬 서버다
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("두 독립 연결의 동시 경쟁을 실제로 재현한다: 같은 키 동시 삽입은 유일 제약으로 하나만 성공한다", async () => {
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("create table race (k text primary key)");
      await a.query("begin");
      await b.query("begin");
      await a.query("insert into race values ('last-copy')");
      const second = b.query("insert into race values ('last-copy')"); // a가 커밋할 때까지 대기한다
      await a.query("commit");
      await expect(second).rejects.toMatchObject({ code: "23505" });
      await b.query("rollback");
      expect((await a.query("select count(*)::int as n from race")).rows[0].n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
