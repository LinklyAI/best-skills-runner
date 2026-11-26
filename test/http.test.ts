import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchJson } from "../src/lib/http.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void;
let handler: Handler = () => {};
let hits = 0;
const server = http.createServer((req, res) => handler(req, res, ++hits));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => server.close());

const FAST = { retryDelayMs: 1, retries: 2 } as const;

function serve(h: Handler): void {
  hits = 0;
  handler = h;
}

/** Sends the status line and half a body, then drops the connection. */
function cutOff(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
  res.write('{"a":');
  setTimeout(() => req.socket.destroy(), 10);
}

test("a body cut off mid-read is retried", async () => {
  serve((req, res, hit) => (hit === 1 ? cutOff(req, res) : res.end('{"ok":true}')));
  assert.deepEqual(await fetchJson(url, FAST), { ok: true });
  assert.equal(hits, 2);
});

test("a body that keeps getting cut off fails after all attempts", async () => {
  serve((req, res) => cutOff(req, res));
  await assert.rejects(fetchJson(url, FAST), /Failed after 3 attempts: .*terminated/);
  assert.equal(hits, 3);
});

test("a retryable status is retried", async () => {
  serve((_req, res, hit) => {
    if (hit === 1) {
      res.writeHead(503);
      res.end("busy");
    } else res.end('{"ok":true}');
  });
  assert.deepEqual(await fetchJson(url, FAST), { ok: true });
  assert.equal(hits, 2);
});

test("a non-retryable status fails at once", async () => {
  serve((_req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  await assert.rejects(fetchJson(url, FAST), /HTTP 404/);
  assert.equal(hits, 1);
});

test("malformed JSON is not retried", async () => {
  serve((_req, res) => res.end("<html>"));
  await assert.rejects(fetchJson(url, FAST), /invalid JSON/);
  assert.equal(hits, 1);
});

test("onRequest counts every request sent, retries included", async () => {
  serve((req, res, hit) => (hit < 3 ? cutOff(req, res) : res.end("{}")));
  let sent = 0;
  await fetchJson(url, { ...FAST, onRequest: () => sent++ });
  assert.equal(sent, 3);
});
