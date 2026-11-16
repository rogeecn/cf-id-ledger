const BODY_LIMIT = 1 << 20;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();

export interface Env {
  DB: D1Database;
  ID_LEDGER_TOKEN: string;
}

interface Cursor {
  t: number;
  i: string;
  s: number;
  u: number;
}

interface StoredID {
  remote_id: string;
  created_at: number;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();
    const head = method === "HEAD";
    const body = await readLimitedBody(request);
    if (body === null) return textResponse("Request Entity Too Large", 413, head);

    const url = new URL(request.url);
    const path = trimTrailingSlash(url.pathname);
    const health = asciiLower(path) === "/healthz" && (method === "GET" || head);
    if (health) return jsonResponse({ status: "ok" }, 200, head);

    const segments = path.split("/");
    const idsRoute = segments.length === 5
      && segments[0] === ""
      && asciiLower(segments[1]) === "v1"
      && asciiLower(segments[2]) === "projects"
      && asciiLower(segments[4]) === "ids";

    if (!await authorized(request.headers.get("Authorization") ?? "", env.ID_LEDGER_TOKEN)) {
      return jsonResponse({ error: "unauthorized" }, 401, head);
    }
    if (!idsRoute || (method !== "POST" && method !== "GET" && !head)) {
      return textResponse(`Cannot ${method} ${url.pathname}`, 404, head);
    }

    const projectKey = segments[3];
    if (projectKey === "") return jsonResponse({ error: "project key is required" }, 400, head);
    if (method === "POST") return writeIDs(body, projectKey, env, head);
    return listIDs(url.searchParams, projectKey, env, head);
  },
};

export default worker;

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > BODY_LIMIT) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function authorized(header: string, configuredToken: string): Promise<boolean> {
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token === "") return false;
  const [providedHash, configuredHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
  ]);
  return constantTimeEqual(new Uint8Array(providedHash), new Uint8Array(configuredHash))
    && configuredToken !== "";
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function writeIDs(body: Uint8Array, projectKey: string, env: Env, head: boolean): Promise<Response> {
  let ids: string[] | null;
  try {
    ids = decodeWriteIDs(new TextDecoder().decode(body));
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, head);
  }
  if (ids === null || ids.length === 0 || ids.length > MAX_BATCH_SIZE) {
    return jsonResponse({ error: "ids must contain between 1 and 1000 values" }, 400, head);
  }
  if (ids.some((id) => id === "")) {
    return jsonResponse({ error: "ids cannot contain empty strings" }, 400, head);
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const statements = ids.map((id) => env.DB.prepare(
    "INSERT INTO collected_ids (project_key, remote_id, created_at) VALUES (?, ?, ?) ON CONFLICT (project_key, remote_id) DO NOTHING",
  ).bind(projectKey, id, createdAt));

  try {
    const results = await env.DB.batch(statements);
    const inserted = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
    return jsonResponse({ received: ids.length, inserted }, 200, head);
  } catch {
    return jsonResponse({ error: "database error" }, 500, head);
  }
}

function decodeWriteIDs(text: string): string[] | null {
  const value: unknown = JSON.parse(text);
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request object");

  let rawIDs: unknown;
  for (const [key, field] of Object.entries(value)) {
    if (key.toLowerCase() !== "ids") throw new Error("unknown field");
    rawIDs = field;
  }
  if (rawIDs === null || rawIDs === undefined) return null;
  if (!Array.isArray(rawIDs)) throw new Error("ids must be an array");

  return rawIDs.map((id) => {
    if (id === null) return "";
    if (typeof id !== "string") throw new Error("ids must contain strings");
    return id;
  });
}

async function listIDs(params: URLSearchParams, projectKey: string, env: Env, head: boolean): Promise<Response> {
  let pageSize: number;
  try {
    pageSize = parsePageSize(params.get("limit") ?? "");
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, head);
  }

  const cursorValue = params.get("cursor") ?? "";
  let cursor: Cursor;
  if (cursorValue === "") {
    try {
      const since = parseTime(params.get("since") ?? "", true);
      let until = parseTime(params.get("until") ?? "", false);
      if (until === undefined) until = Math.floor(Date.now() / 1000) + 1;
      cursor = { t: 0, i: "", s: since, u: until };
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, head);
    }
  } else {
    try {
      cursor = decodeCursor(cursorValue);
    } catch {
      return jsonResponse({ error: "invalid cursor" }, 400, head);
    }
  }

  if (cursor.s >= cursor.u) {
    return jsonResponse({ error: "since must be before until" }, 400, head);
  }

  const pageLimit = pageSize + 1;
  let result: D1Result<StoredID>;
  try {
    const statement = cursorValue === ""
      ? env.DB.prepare(`SELECT remote_id, created_at
          FROM collected_ids
          WHERE project_key = ? AND created_at >= ? AND created_at < ?
          ORDER BY created_at DESC, remote_id DESC
          LIMIT ?`).bind(projectKey, cursor.s, cursor.u, pageLimit)
      : env.DB.prepare(`SELECT remote_id, created_at
          FROM collected_ids
          WHERE project_key = ? AND created_at >= ? AND created_at < ?
            AND (created_at < ? OR (created_at = ? AND remote_id < ?))
          ORDER BY created_at DESC, remote_id DESC
          LIMIT ?`).bind(projectKey, cursor.s, cursor.u, cursor.t, cursor.t, cursor.i, pageLimit);
    result = await statement.all<StoredID>();
  } catch {
    return jsonResponse({ error: "database error" }, 500, head);
  }

  const hasNext = result.results.length > pageSize;
  const rows = hasNext ? result.results.slice(0, pageSize) : result.results;
  const response: { items: Array<{ id: string; created_at: string }>; next_cursor?: string } = {
    items: rows.map((row) => ({ id: row.remote_id, created_at: formatTime(row.created_at) })),
  };
  if (hasNext) {
    const last = rows[rows.length - 1];
    response.next_cursor = encodeCursor({ t: last.created_at, i: last.remote_id, s: cursor.s, u: cursor.u });
  }
  return jsonResponse(response, 200, head);
}

function parsePageSize(value: string): number {
  if (value === "") return DEFAULT_PAGE_SIZE;
  if (!/^[+-]?\d+$/.test(value)) throw new Error("limit must be between 1 and 1000");
  const pageSize = Number(value);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error("limit must be between 1 and 1000");
  }
  return pageSize;
}

function parseTime(value: string, required: true): number;
function parseTime(value: string, required: false): number | undefined;
function parseTime(value: string, required: boolean): number | undefined {
  if (value === "") {
    if (required) throw new Error("since is required");
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("times must use whole-second RFC3339");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    throw new Error("times must use whole-second RFC3339");
  }

  let offsetSeconds = 0;
  if (match[7] !== "Z") {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) throw new Error("times must use whole-second RFC3339");
    const sign = match[8] === "+" ? 1 : -1;
    offsetSeconds = sign * (offsetHour * 3600 + offsetMinute * 60);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000 - offsetSeconds;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function decodeCursor(value: string): Cursor {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("invalid base64");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(standard + "=".repeat((4 - standard.length % 4) % 4)), (character) => character.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  const decoded: unknown = JSON.parse(json);
  const cursor: Cursor = { t: 0, i: "", s: 0, u: 0 };
  if (decoded === null) throw new Error("incomplete cursor");
  if (typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cursor object");

  for (const [key, rawValue] of readCursorFields(json)) {
    switch (key.toLowerCase()) {
      case "t":
      case "s":
      case "u": {
        if (rawValue === "null") break;
        if (!/^-?(?:0|[1-9]\d*)$/.test(rawValue)) throw new Error("invalid cursor number");
        const integer = BigInt(rawValue);
        if (integer < MIN_INT64 || integer > MAX_INT64) throw new Error("invalid cursor number");
        cursor[key.toLowerCase() as "t" | "s" | "u"] = Number(integer);
        break;
      }
      case "i": {
        if (rawValue === "null") break;
        const field: unknown = JSON.parse(rawValue);
        if (typeof field !== "string") throw new Error("invalid cursor ID");
        cursor.i = field;
        break;
      }
    }
  }
  if (cursor.i === "" || cursor.t === 0) throw new Error("incomplete cursor");
  return cursor;
}

function readCursorFields(json: string): Array<[string, string]> {
  let position = skipJSONSpace(json, 0);
  const fields: Array<[string, string]> = [];
  if (json[position] !== "{") return fields;
  position++;

  while (position < json.length) {
    position = skipJSONSpace(json, position);
    if (json[position] === "}") return fields;

    const keyStart = position;
    position = skipJSONString(json, position);
    const key = JSON.parse(json.slice(keyStart, position)) as string;
    position = skipJSONSpace(json, position);
    position++;
    position = skipJSONSpace(json, position);

    const valueStart = position;
    position = skipJSONValue(json, position);
    fields.push([key, json.slice(valueStart, position)]);
    position = skipJSONSpace(json, position);
    if (json[position] !== ",") return fields;
    position++;
  }
  throw new Error("invalid cursor object");
}

function skipJSONSpace(json: string, position: number): number {
  while (json[position] === " " || json[position] === "\t" || json[position] === "\r" || json[position] === "\n") {
    position++;
  }
  return position;
}

function skipJSONString(json: string, position: number): number {
  for (let index = position + 1; index < json.length; index++) {
    if (json[index] === "\\") index++;
    else if (json[index] === '"') return index + 1;
  }
  throw new Error("invalid cursor string");
}

function skipJSONValue(json: string, start: number): number {
  if (json[start] === '"') return skipJSONString(json, start);
  if (json[start] !== "{" && json[start] !== "[") {
    let position = start;
    while (position < json.length && !/[,}\]\s]/.test(json[position])) position++;
    return position;
  }

  let depth = 0;
  for (let position = start; position < json.length;) {
    const character = json[position];
    if (character === '"') {
      position = skipJSONString(json, position);
    } else if (character === "{" || character === "[") {
      depth++;
      position++;
    } else if (character === "}" || character === "]") {
      depth--;
      position++;
      if (depth === 0) return position;
    } else {
      position++;
    }
  }
  throw new Error("invalid cursor value");
}

function encodeCursor(cursor: Cursor): string {
  const bytes = encoder.encode(JSON.stringify({ t: cursor.t, i: cursor.i, s: cursor.s, u: cursor.u }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function jsonResponse(value: unknown, status: number, head: boolean): Response {
  return new Response(head ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(value: string, status: number, head: boolean): Response {
  return new Response(head ? null : value, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid request";
}
