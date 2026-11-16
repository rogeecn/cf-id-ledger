import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __D1_MIGRATIONS__);
});

it("maps a real D1 read failure to the original database error", async () => {
  await env.DB.prepare("DROP TABLE collected_ids").run();
  const response = await SELF.fetch(new Request(
    "http://ledger.test/v1/projects/demo/ids?since=2023-11-14T22%3A13%3A10Z",
    { headers: { Authorization: "Bearer local-test-token" } },
  ));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "database error" });
});
