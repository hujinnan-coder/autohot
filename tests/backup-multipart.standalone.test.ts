// Backups travel two ways: below the threshold one PUT, above it S3 multipart. The upload was split
// because a 3.3 GB dump PUT in one request was cut by the store after several minutes on a slow link;
// parts make every request short and retry only the part that failed. The store below is a stub in
// this process — the fixture never contacts a real service.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { upload, type Store } from "@aihot/backend/operations/backup";

const T = tag();
const originalFetch = globalThis.fetch;
const UPLOAD_ID = `upload-${T}`;
const uploads: Array<{ number: number; bytes: Buffer }> = [];
const sizes = new Map<string, number>();
const heads: string[] = [];
let headOverride: Response | undefined;
let creates = 0;
let singlePuts = 0;
let completed: string | null = null;
let aborted: string | null = null;
let failPart: number | null = null;
let failAlways = false;
let completeBody: string | undefined;
let abortStatus = 204;
let failedOnce = false;

/** A store the fixtures drive: a domain endpoint, so every request stays inside this process. */
const store: Store = {
  secretId: "test-backup-id",
  secretKey: "test-backup-key",
  bucket: "test-bucket",
  region: "auto",
  endpoint: "https://backup.invalid",
};

const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://backup.invalid", "the fixture must not contact any real service");
  const method = init?.method ?? "GET";
  const body = init?.body;

  if (method === "HEAD") {
    assert.equal(url.search, "", "verify the completed object key");
    heads.push(url.pathname);
    if (headOverride) return headOverride;
    const size = sizes.get(url.pathname);
    if (size === undefined) return new Response(null, { status: 404 });
    return new Response(null, { headers: { "Content-Length": String(size) } });
  }
  if (method === "POST" && url.searchParams.has("uploads")) {
    creates += 1;
    return xml(`<InitiateMultipartUploadResult><UploadId>${UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (method === "DELETE") {
    aborted = url.searchParams.get("uploadId");
    return new Response(null, { status: abortStatus });
  }
  if (method === "PUT" && url.searchParams.has("partNumber")) {
    const number = Number(url.searchParams.get("partNumber"));
    if (failPart === number && (failAlways || !failedOnce)) {
      failedOnce = true;
      return new Response("busy", { status: 503 });
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(await new Response(body as BodyInit).arrayBuffer());
    uploads.push({ number, bytes });
    return new Response(null, { status: 200, headers: { etag: `"etag-${number}"` } });
  }
  if (method === "POST" && url.searchParams.has("uploadId")) {
    completed = typeof body === "string" ? body : String(body);
    if (completeBody === undefined) sizes.set(url.pathname, uploads.reduce((total, { bytes }) => total + bytes.length, 0));
    // A complete may answer 200 and put the failure in the body; the status alone reads as success.
    return xml(completeBody ?? ' \n <?xml version="1.0"?> <CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ETag>"complete"</ETag></CompleteMultipartUploadResult>');
  }
  if (method === "PUT") {
    singlePuts += 1;
    let size = 0;
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) size += chunk.length;
    sizes.set(url.pathname, size);
    return new Response(null, { status: 200 });
  }
  return new Response("unexpected", { status: 400 });
}) as typeof fetch;

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aihot-multipart-"));
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (dir) await rm(dir, { recursive: true, force: true });
});

const reset = () => {
  uploads.length = 0;
  sizes.clear();
  heads.length = 0;
  headOverride = undefined;
  creates = 0;
  singlePuts = 0;
  completed = null;
  aborted = null;
  failPart = null;
  failAlways = false;
  completeBody = undefined;
  abortStatus = 204;
  failedOnce = false;
};

async function fixture(bytes: number) {
  const file = path.join(dir, `payload-${bytes}-${T}.bin`);
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) data[i] = i % 251;
  await writeFile(file, data);
  return { file, data, sha: createHash("sha256").update(data).digest("hex") };
}

test("a dump above the threshold goes up in parts, each its own request, and the ETags are listed back", async () => {
  reset();
  const { file, data, sha } = await fixture(2 * 1024 * 1024 + 512 * 1024);
  await upload(store, "daily/dump.bin", file, sha, data.length, { partSize: 1024 * 1024, threshold: 1024 * 1024 });
  assert.equal(creates, 1, "one multipart start");
  assert.deepEqual(uploads.map((p) => p.number), [1, 2, 3], "the parts arrive in order");
  assert.deepEqual(uploads.map((p) => p.bytes.length), [1024 * 1024, 1024 * 1024, 512 * 1024]);
  assert.equal(Buffer.concat(uploads.map((p) => p.bytes)).equals(data), true, "the parts carry the file unchanged");
  assert.ok(completed !== null && !completed.includes("<UploadId>"), "the completion body lists parts, not the upload id");
  for (const number of [1, 2, 3]) assert.ok(completed?.includes(`<ETag>"etag-${number}"</ETag>`), `part ${number} is completed`);
  assert.equal(aborted, null, "a finished upload is not aborted");
  assert.equal(singlePuts, 0);
  assert.deepEqual(heads, ["/daily/dump.bin"]);
});

test("a part the store refuses is sent again, and the upload still finishes", async () => {
  reset();
  const { file, data, sha } = await fixture(1024 * 1024 + 1024);
  failPart = 2;
  await upload(store, "daily/retry.bin", file, sha, data.length, { partSize: 1024 * 1024, threshold: 1024 * 1024 });
  assert.equal(failedOnce, true, "the fixture refused one part once");
  assert.deepEqual(uploads.map((p) => p.number), [1, 2]);
  assert.ok(completed, "the retried part still completed the upload");
});

test("below the threshold the whole file is one PUT followed by verification", async () => {
  reset();
  const { file, data, sha } = await fixture(64 * 1024);
  await upload(store, "daily/small.bin", file, sha, data.length, { threshold: 1024 * 1024 });
  assert.equal(creates, 0);
  assert.equal(singlePuts, 1);
  assert.equal(uploads.length, 0);
  assert.deepEqual(heads, ["/daily/small.bin"]);
});

test("a shorter completed multipart object fails verification", async () => {
  reset();
  const { file, data, sha } = await fixture(2048);
  headOverride = new Response(null, { headers: { "Content-Length": String(data.length - 1) } });
  await assert.rejects(upload(store, "daily/truncated.bin", file, sha, data.length, { partSize: 1024, threshold: 1024 }), /backup verify .*: HTTP 200, 2047 bytes \(expected 2048\)/);
  assert.equal(aborted, null, "the multipart upload ID is already closed");
});

test("a missing object after a PUT fails verification", async () => {
  reset();
  const { file, data, sha } = await fixture(1024);
  headOverride = new Response(null, { status: 404 });
  await assert.rejects(upload(store, "daily/missing.bin", file, sha, data.length), /backup verify .*: HTTP 404/);
  assert.equal(singlePuts, 1);
});

test("a part that keeps failing aborts the upload instead of leaving parts behind", async () => {
  reset();
  const { file, data, sha } = await fixture(2 * 1024 * 1024);
  failPart = 1;
  failAlways = true;
  await assert.rejects(
    upload(store, "daily/broken.bin", file, sha, data.length, { partSize: 1024 * 1024, threshold: 1024 * 1024 }),
    /HTTP 503/,
  );
  assert.equal(aborted, UPLOAD_ID, "the unfinished upload is deleted");
});

test("a complete that answers 200 with an <Error> body fails the upload instead of reporting success", async () => {
  reset();
  const { file, data, sha } = await fixture(2 * 1024 * 1024);
  completeBody = "<Error><Code>InternalError</Code><Message>try again</Message></Error>";
  await assert.rejects(
    upload(store, "daily/error-body.bin", file, sha, data.length, { partSize: 1024 * 1024, threshold: 1024 * 1024 }),
    /InternalError/,
  );
  assert.equal(aborted, UPLOAD_ID, "the upload is aborted so no half-joined object stays behind");
});

test("without a final result, completion fails and a rejected abort is reported", async () => {
  reset();
  const { file, data, sha } = await fixture(2 * 1024 * 1024);
  completeBody = " \n ";
  abortStatus = 403;
  await assert.rejects(
    upload(store, "daily/empty-result.bin", file, sha, data.length, { partSize: 1024 * 1024, threshold: 1024 * 1024 }),
    /without a complete upload result; abort multipart failed: Error: HTTP 403/,
  );
});
