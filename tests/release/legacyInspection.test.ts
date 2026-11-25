import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "release/legacy_readonly_inspection.sql";

/** 주석과 문자열 리터럴을 지워 키워드 검사가 값에 속지 않게 한다 */
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

describe("레거시 DB 점검 SQL (E5)은 읽기 전용이다", () => {
  it("모든 문장이 SELECT/WITH로 시작하고, 변경·권한·세션 변경 키워드가 없으며, 점검 대상(함수·권한·테이블·제약·트리거·정책·private 스키마)을 모두 다룬다", () => {
    expect(existsSync(FILE), `${FILE} 파일이 있어야 한다`).toBe(true);
    const sql = readFileSync(FILE, "utf8");
    const statements = strip(sql).split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThanOrEqual(8);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 60)).toMatch(/^(select|with)\b/i);
      expect(statement, statement.slice(0, 60)).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|set|reset|vacuum|lock|begin|commit|rollback|execute|refresh|comment)\b/i);
    }
    for (const needle of ["pg_proc", "has_function_privilege", "pg_get_functiondef", "information_schema.columns", "pg_constraint", "pg_trigger", "pg_policies", "role_table_grants", "'private'"]) {
      expect(sql, needle).toContain(needle);
    }
  });
});

describe("점검 SQL을 격리 DB에서 읽기 전용 트랜잭션으로 실행한다", () => {
  it("모든 문장이 오류 없이 실행되고 결과가 나오며, 실행 뒤에도 DB가 변하지 않는다", async () => {
    const { startMigratedPostgres } = await import("../helpers/migratedPostgres");
    const db = await startMigratedPostgres();
    const client = await db.connect();
    try {
      const statements = strip(readFileSync(FILE, "utf8")).split(";").map((s) => s.trim()).filter(Boolean);
      // 주석을 지운 문장 대신 원문(주석 포함, 리터럴 보존)을 문장 단위로 나눠 실행한다
      const original = readFileSync(FILE, "utf8").replace(/--[^\n]*/g, "").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
      expect(original.length).toBe(statements.length);
      const before = (await client.query("select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace")).rows[0].n;
      await client.query("begin read only");
      const counts: Record<string, number> = {};
      try {
        for (const [index, statement] of original.entries()) counts[`#${index + 1}`] = (await client.query(statement)).rowCount ?? 0;
      } finally {
        await client.query("rollback");
      }
      // 새 마이그레이션의 보호 함수는 private 스키마에 있고 public에는 ordering 함수가 없다(그래서 #1은 비어 있다. 레거시 DB에서는 RPC가 나온다)
      expect(counts["#1"]).toBe(0);
      expect(counts["#3"]).toBeGreaterThan(100); // 열
      expect(counts["#4"]).toBeGreaterThan(50); // 제약
      expect(counts["#5"]).toBeGreaterThan(10); // 트리거
      expect(counts["#9"]).toBeGreaterThan(0); // private 함수
      expect(Object.values(counts).every((n) => typeof n === "number")).toBe(true);
      expect((await client.query("select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace")).rows[0].n).toBe(before);
    } finally {
      await client.end();
      await db.stop();
    }
  }, 240_000);
});
