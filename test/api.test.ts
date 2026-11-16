import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const TOKEN = "local-test-token";
const STAMP = 1_700_000_000;
const SINCE = "2023-11-14T22:13:10Z";
const UNTIL = "2023-11-14T22:13:21Z";
const GO_CURSOR_WITH_EXTRA = "eyJ0IjoxNzAwMDAwMDAwLCJpIjoi6ZuqIiwicyI6MTY5OTk5OTk5MCwidSI6MTcwMDAwMDAwMSwiZnV0dXJlIjp0cnVlfQ";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __D1_MIGRATIONS__);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM collected_ids").run();
});

function request(method: string, path: string, body?: string, token: string | undefined = TOKEN) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  return SELF.fetch(new Request(`http://ledger.test${path}`, { method, headers, body }));
}

async function seed(project: string, ids: string[], createdAt = STAMP) {
  await env.DB.batch(ids.map((id) =>
    env.DB.prepare("INSERT INTO collected_ids(project_key, remote_id, created_at) VALUES (?, ?, ?)")
      .bind(project, id, createdAt),
  ));
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("ID Ledger Worker API", () => {
  it("keeps health public and matches Fiber static-case, trailing-slash, and HEAD routes", async () => {
    const health = await request("GET", "/HeAlThZ/");
    expect(health.status).toBe(200);
    expect(await body(health)).toEqual({ status: "ok" });

    const head = await request("HEAD", "/HEALTHZ/");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const protectedHead = await request("HEAD", "/V1/PROJECTS/MiXeD/IDS?since=2023-11-14T22%3A13%3A10Z");
    expect(protectedHead.status).toBe(200);
    expect(await protectedHead.text()).toBe("");

    const unmatched = await request("PATCH", "/v1/projects/demo/ids");
    expect(unmatched.status).toBe(404);
    expect(await unmatched.text()).toBe("Cannot PATCH /v1/projects/demo/ids");

    const emptyProject = await request("POST", "/v1/projects//ids", '{"ids":["x"]}');
    expect(emptyProject.status).toBe(400);
    expect(await body(emptyProject)).toEqual({ error: "project key is required" });
  });

  it("rejects a wrong or blank bearer token without exposing configuration", async () => {
    const wrong = await request("GET", `/v1/projects/demo/ids?since=${encodeURIComponent(SINCE)}`, undefined, "bad");
    expect(wrong.status).toBe(401);
    expect(await body(wrong)).toEqual({ error: "unauthorized" });

    const wrongPrefix = await SELF.fetch(new Request(`http://ledger.test/v1/projects/demo/ids?since=${encodeURIComponent(SINCE)}`, {
      headers: { Authorization: `bearer ${TOKEN}` },
    }));
    expect(wrongPrefix.status).toBe(401);
    expect(await body(wrongPrefix)).toEqual({ error: "unauthorized" });

    const blankEnv = await worker.fetch(
      new Request(`http://ledger.test/v1/projects/demo/ids?since=${encodeURIComponent(SINCE)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      { DB: env.DB, ID_LEDGER_TOKEN: "" },
    );
    expect(blankEnv.status).toBe(401);
    expect(await body(blankEnv)).toEqual({ error: "unauthorized" });
  });

  it("accepts Go's case-insensitive ids field and preserves server-only first-write timestamps", async () => {
    const first = await request("POST", "/V1/PROJECTS/MiXeD/IDS/", '{"IDS":["A","a","A"]}');
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({ received: 3, inserted: 2 });

    await env.DB.prepare("UPDATE collected_ids SET created_at = ? WHERE project_key = ? AND remote_id = ?")
      .bind(STAMP - 5, "MiXeD", "A").run();
    const retry = await request("POST", "/v1/projects/MiXeD/ids", '{"ids":["A"]}');
    expect(await body(retry)).toEqual({ received: 1, inserted: 0 });

    const lowerProject = await request("POST", "/v1/projects/mixed/ids", '{"ids":["A"]}');
    expect(await body(lowerProject)).toEqual({ received: 1, inserted: 1 });
    const lowerId = await request("POST", "/v1/projects/MiXeD/ids", '{"ids":["a"]}');
    expect(await body(lowerId)).toEqual({ received: 1, inserted: 0 });

    const stored = await env.DB.prepare("SELECT created_at FROM collected_ids WHERE project_key = ? AND remote_id = ?")
      .bind("MiXeD", "A").first<{ created_at: number }>();
    expect(stored?.created_at).toBe(STAMP - 5);
    const listing = await request("GET", "/v1/projects/MiXeD/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    const mixedItems = (await body(listing)).items as Array<{ id: string; created_at: string }>;
    expect(mixedItems.map((item) => item.id)).toEqual(["a", "A"]);
    expect(mixedItems[1].created_at).toBe("2023-11-14T22:13:15Z");
    const isolated = await request("GET", "/v1/projects/mixed/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    expect((await body(isolated)).items).toMatchObject([{ id: "A", created_at: expect.any(String) }]);
  });

  it("uses the last duplicate case-insensitive ids member", async () => {
    const payload = '{"ids":["a"],"IDS":["b"],"ids":["c"]}';
    const response = await request("POST", "/v1/projects/duplicate-valid/ids", payload);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ received: 1, inserted: 1 });

    const listing = await request("GET", "/v1/projects/duplicate-valid/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    const items = (await body(listing)).items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["c"]);
  });

  it("validates every duplicate ids member before applying the last value", async () => {
    const payload = '{"ids":[1],"ids":["ok"]}';
    const response = await request("POST", "/v1/projects/duplicate-invalid/ids", payload);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: "invalid JSON body" });

    const listing = await request("GET", "/v1/projects/duplicate-invalid/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    expect((await body(listing)).items).toEqual([]);
  });

  it("reuses a prior duplicate ids member's backing value for null", async () => {
    const response = await request("POST", "/v1/projects/null-reuse-one/ids", '{"ids":["a"],"ids":[null]}');
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ received: 1, inserted: 1 });

    const listing = await request("GET", "/v1/projects/null-reuse-one/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    const items = (await body(listing)).items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["a"]);
  });

  it("reuses duplicate ids member values by index after shrink and expansion", async () => {
    const response = await request("POST", "/v1/projects/null-reuse-many/ids", '{"ids":["a","b"],"ids":[null,"c"]}');
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ received: 2, inserted: 2 });

    const listing = await request("GET", "/v1/projects/null-reuse-many/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    const items = (await body(listing)).items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["c", "a"]);
  });

  it("retains duplicate ids member values beyond a shorter array", async () => {
    const response = await request("POST", "/v1/projects/null-reuse-expand/ids", '{"ids":["a","b"],"ids":["c"],"ids":[null,null]}');
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ received: 2, inserted: 2 });

    const listing = await request("GET", "/v1/projects/null-reuse-expand/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z");
    const items = (await body(listing)).items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["c", "b"]);
  });

  it("clears duplicate ids member backing values for an empty or null member", async () => {
    const cases = [
      ["empty-array", '{"ids":["a"],"ids":[],"ids":[null]}'],
      ["null-member", '{"ids":["a"],"ids":null,"ids":[null]}'],
      ["empty-string", '{"ids":[""],"ids":[null]}'],
    ] as const;
    for (const [project, payload] of cases) {
      const response = await request("POST", `/v1/projects/null-reuse-${project}/ids`, payload);
      expect(response.status, payload).toBe(400);
      expect(await body(response), payload).toEqual({ error: "ids cannot contain empty strings" });

      const listing = await request("GET", `/v1/projects/null-reuse-${project}/ids?since=1970-01-01T00%3A00%3A00Z&until=2100-01-01T00%3A00%3A00Z`);
      expect((await body(listing)).items, payload).toEqual([]);
    }
  });

  it("matches Go JSON null, missing, unknown-field, type, and trailing-value behavior", async () => {
    const cases: Array<[string, string]> = [
      ['{"ids":null}', "ids must contain between 1 and 1000 values"],
      ['{}', "ids must contain between 1 and 1000 values"],
      ['{"ids":[null]}', "ids cannot contain empty strings"],
      ['{"ids":[""]}', "ids cannot contain empty strings"],
      ['{"ids":[1]}', "invalid JSON body"],
      ['{"ids":["one"],"created_at":1}', "invalid JSON body"],
      ['{"ids":["one"]} {}', "invalid JSON body"],
      ["not-json", "invalid JSON body"],
    ];
    for (const [payload, message] of cases) {
      const response = await request("POST", "/v1/projects/demo/ids", payload);
      expect(response.status, payload).toBe(400);
      expect(await body(response), payload).toEqual({ error: message });
    }
  });

  it("validates batch bounds before values", async () => {
    for (const ids of [[], Array.from({ length: 1001 }, (_, index) => `id-${index}`)]) {
      const response = await request("POST", "/v1/projects/demo/ids", JSON.stringify({ ids }));
      expect(response.status).toBe(400);
      expect(await body(response)).toEqual({ error: "ids must contain between 1 and 1000 values" });
    }
  });

  it("enforces Fiber's 1 MiB request body limit", async () => {
    const largeBody = `{"ids":["${"x".repeat(1 << 20)}"]}`;
    const response = await request("POST", "/v1/projects/demo/ids", largeBody);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Request Entity Too Large");
  });

  it("writes a full 1000-ID batch and ignores duplicates", async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `id-${index}`);
    const response = await request("POST", "/v1/projects/demo/ids", JSON.stringify({ ids }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ received: 1000, inserted: 1000 });

    const retry = await request("POST", "/v1/projects/demo/ids", JSON.stringify({ ids }));
    expect(await body(retry)).toEqual({ received: 1000, inserted: 0 });
  });

  it("rolls back a 1000-ID D1 batch on the last statement and allows a clean retry", async () => {
    await seed("demo", ["existing"]);
    const ids = Array.from({ length: 999 }, (_, index) => `pending-${index}`);
    ids.push("fail-last");
    const payload = JSON.stringify({ ids });
    await env.DB.prepare(`CREATE TRIGGER fail_last BEFORE INSERT ON collected_ids
      WHEN NEW.remote_id = 'fail-last'
      BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END`).run();

    try {
      const failed = await request("POST", "/v1/projects/demo/ids", payload);
      expect(failed.status).toBe(500);
      expect(await body(failed)).toEqual({ error: "database error" });
      const rows = await env.DB.prepare("SELECT remote_id, created_at FROM collected_ids WHERE project_key = ? ORDER BY remote_id")
        .bind("demo").all<{ remote_id: string; created_at: number }>();
      expect(rows.results).toEqual([{ remote_id: "existing", created_at: STAMP }]);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_last").run();
    }

    const retry = await request("POST", "/v1/projects/demo/ids", payload);
    expect(await body(retry)).toEqual({ received: 1000, inserted: 1000 });
    const secondRetry = await request("POST", "/v1/projects/demo/ids", payload);
    expect(await body(secondRetry)).toEqual({ received: 1000, inserted: 0 });
    const rowsAfter = await env.DB.prepare("SELECT remote_id, created_at FROM collected_ids WHERE project_key = ? ORDER BY remote_id")
      .bind("demo").all<{ remote_id: string; created_at: number }>();
    expect(rowsAfter.results).toHaveLength(1001);
    expect(rowsAfter.results[0]).toEqual({ remote_id: "existing", created_at: STAMP });
    expect(rowsAfter.results.at(-1)?.remote_id).toBe("pending-998");
  });

  it("uses inclusive since, exclusive until, and accepts timezone offsets", async () => {
    await seed("demo", ["at-since"], STAMP);
    await seed("demo", ["before-until"], STAMP + 1);
    await seed("demo", ["at-until"], STAMP + 2);
    const path = "/v1/projects/demo/ids?since=2023-11-15T00%3A13%3A20%2B02%3A00&until=2023-11-15T00%3A13%3A22%2B02%3A00";
    const response = await request("GET", path);
    expect(response.status).toBe(200);
    expect((await body(response)).items).toEqual([
      { id: "before-until", created_at: "2023-11-14T22:13:21Z" },
      { id: "at-since", created_at: "2023-11-14T22:13:20Z" },
    ]);
  });

  it("rejects invalid dates and Go-incompatible page-size shapes", async () => {
    const cases = [
      ["?until=2023-11-14T22%3A13%3A21Z", "since is required"],
      ["?since=2023-02-29T00%3A00%3A00Z", "times must use whole-second RFC3339"],
      ["?since=2023-11-14T22%3A13%3A20.5Z", "times must use whole-second RFC3339"],
      ["?since=2023-11-14T22%3A13%3A20Z&until=2023-11-14T22%3A13%3A20Z", "since must be before until"],
      ["?since=2023-11-14T22%3A13%3A10Z&limit=1e2", "limit must be between 1 and 1000"],
      ["?since=2023-11-14T22%3A13%3A10Z&limit=%2B0", "limit must be between 1 and 1000"],
      ["?since=2023-11-14T22%3A13%3A10Z&limit=1001", "limit must be between 1 and 1000"],
    ] as const;
    for (const [query, message] of cases) {
      const response = await request("GET", `/v1/projects/demo/ids${query}`);
      expect(response.status, query).toBe(400);
      expect(await body(response), query).toEqual({ error: message });
    }

    const plusOne = await request("GET", "/v1/projects/demo/ids?since=2023-11-14T22%3A13%3A10Z&limit=%2B1");
    expect(plusOne.status).toBe(200);
  });

  it("paginates same-second Unicode IDs in SQLite binary order and emits a Go-readable cursor", async () => {
    await seed("demo", ["a", "z", "é", "雪", "😀"]);
    const first = await request("GET", `/v1/projects/demo/ids?since=${SINCE}&until=${UNTIL}&limit=2`);
    const page1 = await body(first) as { items: Array<{ id: string; created_at: string }>; next_cursor: string };
    expect(page1.items.map((item) => item.id)).toEqual(["😀", "雪"]);
    expect(page1.items[0].created_at).toBe("2023-11-14T22:13:20Z");
    const cursorJson = new TextDecoder().decode(decodeBase64Url(page1.next_cursor));
    expect(cursorJson).toBe('{"t":1700000000,"i":"雪","s":1699999990,"u":1700000001}');

    const second = await request("GET", `/v1/projects/demo/ids?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`);
    const page2 = await body(second) as { items: Array<{ id: string }>; next_cursor: string };
    expect(page2.items.map((item) => item.id)).toEqual(["é", "z"]);
    expect(page2.next_cursor).not.toBe("");
    const third = await request("GET", `/v1/projects/demo/ids?limit=2&cursor=${encodeURIComponent(page2.next_cursor)}`);
    const page3 = await body(third) as { items: Array<{ id: string }>; next_cursor?: string };
    expect(page3.items.map((item) => item.id)).toEqual(["a"]);
    expect(page3.next_cursor).toBeUndefined();
  });

  it("accepts a literal Go cursor with unknown fields", async () => {
    await seed("demo", ["a", "z", "é", "雪", "😀"]);
    const response = await request("GET", `/v1/projects/demo/ids?cursor=${GO_CURSOR_WITH_EXTRA}&limit=5`);
    expect(response.status).toBe(200);
    expect((await body(response)).items).toEqual([
      { id: "é", created_at: "2023-11-14T22:13:20Z" },
      { id: "z", created_at: "2023-11-14T22:13:20Z" },
      { id: "a", created_at: "2023-11-14T22:13:20Z" },
    ]);
  });

  it("keeps Go zero values for omitted cursor range fields and rejects malformed cursors", async () => {
    const missingRange = base64Url('{"t":1700000000,"i":"id"}');
    const omitted = await request("GET", `/v1/projects/demo/ids?cursor=${missingRange}`);
    expect(omitted.status).toBe(400);
    expect(await body(omitted)).toEqual({ error: "since must be before until" });

    const nestedUnknown = base64Url('{"future":{"t":1.5},"t":1700000000,"i":"id","s":1699999990,"u":1700000001}');
    expect((await request("GET", `/v1/projects/demo/ids?cursor=${nestedUnknown}`)).status).toBe(200);

    for (const cursor of [
      "%%%",
      base64Url('{"t":"1700000000","i":"id","s":1,"u":2}'),
      base64Url('{"t":1700000000.0,"i":"id","s":1,"u":2}'),
      base64Url('{"t":1.7e9,"i":"id","s":1,"u":2}'),
      base64Url('{"t":9223372036854775808,"i":"id","s":1,"u":2}'),
      base64Url("null"),
    ]) {
      const response = await request("GET", `/v1/projects/demo/ids?cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(await body(response)).toEqual({ error: "invalid cursor" });
    }
  });

  it("freezes an omitted until bound in the next cursor", async () => {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 20;
    await seed("demo", ["first", "second"], now);
    const first = await request("GET", `/v1/projects/demo/ids?since=${new Date(since * 1000).toISOString().replace(".000Z", "Z")}&limit=1`);
    const page1 = await body(first) as { items: Array<{ id: string }>; next_cursor: string };
    const cursor = JSON.parse(new TextDecoder().decode(decodeBase64Url(page1.next_cursor))) as { t: number; i: string; s: number; u: number };
    expect(cursor.u).toBe(now + 1);

    await seed("demo", ["at-bound"], cursor.u);
    const second = await request("GET", `/v1/projects/demo/ids?cursor=${encodeURIComponent(page1.next_cursor)}&limit=5`);
    const page2 = await body(second) as { items: Array<{ id: string }> };
    expect(page2.items.map((item) => item.id)).toEqual([page1.items[0].id === "second" ? "first" : "second"]);
  });
});

function decodeBase64Url(value: string) {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function base64Url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
