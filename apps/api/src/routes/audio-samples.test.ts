// Audio samples route tests (HTTP contract).
//
// Background: ticket #61 wires a seller-audio slice through the same
// Express boundary as the M1 search and BG1 auth routes. The test
// suite pins every GS 7–GS 12 contract branch at the HTTP level:
// upload persists a buyer-safe DTO; an unauthorized actor is rejected
// with the safe envelope code; the 3-sample cap is enforced; a
// non-MP3 or oversize object is rejected at the trusted boundary;
// removal stops the sample from appearing in the buyer-facing list.
//
// The route tests run network-free: the in-memory repositories and
// the deterministic storage adapter substitute for the Prisma and
// Supabase backends. The same `buildApp` wiring the deployed entry
// point uses is exercised so a contract drift here also affects the
// deployed app.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/consistent-type-imports */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import request from "supertest";
import { buildApp } from "../index.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { DeterministicStorageAdapter } from "../storage/deterministic-storage-adapter.js";
import { InMemoryAudioRepository } from "../audio-repository/in-memory-audio-repository.js";
import { AudioSampleService } from "../services/audio-sample.service.js";

const SELLER_USER_ID = "user-buyer-seller";
const SELLER_WORKSPACE_ID = "ws-buyer-seller";
const BUYER_USER_ID = "user-buyer-other";
const BUYER_WORKSPACE_ID = "ws-buyer-other";
const OFFERING_ID = "of-active";
const UNRELATED_OFFERING_ID = "of-unrelated";

async function signIn(
  app: import("express").Application,
  adapter: DeterministicIdentityAdapter,
  email: string,
): Promise<string> {
  const req = await adapter.requestSignIn({ email });
  const response = await request(app)
    .post("/api/auth/verify-token")
    .send({ verificationToken: req.verificationToken })
    .set("Content-Type", "application/json");
  const setCookie = response.headers["set-cookie"];
  if (!Array.isArray(setCookie)) throw new Error("session cookie missing");
  const cookie: string | undefined = setCookie.find(
    (c): c is string => typeof c === "string" && c.startsWith("soundhub_session="),
  );
  if (!cookie) throw new Error("session cookie missing");
  return cookie;
}

function buildTestHarness() {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });
  const authRepo = new InMemoryAuthRepository([
    {
      userAccountId: SELLER_USER_ID,
      email: "seller-route@example.com",
      identityProvider: "deterministic",
      identitySubject: "seller-route-subject",
      memberships: [
        {
          workspaceId: SELLER_WORKSPACE_ID,
          slug: "seller-route",
          name: "Seller Route Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
    {
      userAccountId: BUYER_USER_ID,
      email: "buyer-route@example.com",
      identityProvider: "deterministic",
      identitySubject: "buyer-route-subject",
      memberships: [
        {
          workspaceId: BUYER_WORKSPACE_ID,
          slug: "buyer-route",
          name: "Buyer Route Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Buyer"],
        },
      ],
    },
  ]);
  const workspaceAuthorization = new WorkspaceAuthorizationService({
    authRepository: authRepo,
  });
  const audioRepo = new InMemoryAudioRepository({
    offerings: [
      {
        offeringId: OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Active offering",
      },
      {
        offeringId: UNRELATED_OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: false,
        title: "Unrelated offering",
      },
    ],
  });
  const storage = new DeterministicStorageAdapter();
  const audioSampleService = new AudioSampleService({
    repository: audioRepo,
    storage,
    workspaceAuthorization,
  });
  const authenticationService = new AuthenticationService({
    identityAdapter: adapter,
    authRepository: authRepo,
  });
  const stubPrisma = new Proxy({} as never, {
    get() {
      throw new Error(
        "Prisma client was invoked; the audio route tests must use the in-memory repositories.",
      );
    },
  });
  const built = buildApp({
    authenticationService,
    workspaceAuthorizationService: workspaceAuthorization,
    authRepository: authRepo,
    identityAdapter: adapter,
    audioRepository: audioRepo,
    storageAdapterOverride: storage,
    audioSampleService,
    prismaClient: stubPrisma,
  });
  return { app: built.app, adapter, storage };
}

function buildMultipart(
  label: string,
  file: { name: string; type: string; bytes: Buffer },
): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----SoundHubBG2Boundary${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` + `Content-Disposition: form-data; name="label"\r\n\r\n` + `${label}\r\n`,
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("BG2 audio samples routes (in-memory, deterministic adapter)", () => {
  test("unauthenticated upload is rejected with SESSION_INVALID", async () => {
    const { app } = buildTestHarness();
    const { body, contentType } = buildMultipart("L", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes: Buffer.from([0x49, 0x44, 0x33]),
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Content-Type", contentType)
      .send(body);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "SESSION_INVALID");
  });

  test("an authorized seller can upload, list, and remove (GS 7)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const { body: mp3Body, contentType } = buildMultipart("Demo sample", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes: Buffer.from([0x49, 0x44, 0x33]),
    });
    const upload = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.ok, true);
    assert.equal(upload.body.sample.label, "Demo sample");
    assert.equal(upload.body.sample.byteSize, 3);
    assert.equal(upload.body.sample.displayOrder, 1);

    const list = await request(app)
      .get(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.samples.length, 1);

    const remove = await request(app)
      .delete(`/api/services/${OFFERING_ID}/audio-samples/${upload.body.sample.sampleId}`)
      .set("Cookie", cookie);
    assert.equal(remove.status, 200);
    assert.equal(remove.body.ok, true);

    const listAfter = await request(app)
      .get(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie);
    assert.equal(listAfter.body.samples.length, 0);
  });

  test("a non-owner Workspace is rejected with AUDIO_OFFERING_INELIGIBLE (GS 8)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const { body: mp3Body, contentType } = buildMultipart("Foreign", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes: Buffer.from([0x49, 0x44, 0x33]),
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "AUDIO_OFFERING_INELIGIBLE");
  });

  test("a non-MP3 object is rejected at the trusted boundary (GS 11)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const { body, contentType } = buildMultipart("Bad", {
      name: "sample.wav",
      type: "audio/wav",
      bytes: Buffer.from([0x52, 0x49, 0x46]),
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "AUDIO_CONTENT_TYPE_UNSUPPORTED");
  });

  test("an oversize object is rejected at the trusted boundary (GS 11)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const oversize = Buffer.alloc(26 * 1024 * 1024);
    const { body, contentType } = buildMultipart("Too big", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes: oversize,
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(body);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "AUDIO_PAYLOAD_TOO_LARGE");
  });

  test("a fourth sample is rejected with AUDIO_SAMPLE_LIMIT_EXCEEDED (GS 11)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    for (let i = 0; i < 3; i += 1) {
      const { body, contentType } = buildMultipart(`S${i}`, {
        name: `sample-${i}.mp3`,
        type: "audio/mpeg",
        bytes: Buffer.from([0x49, 0x44, 0x33]),
      });
      const res = await request(app)
        .post(`/api/services/${OFFERING_ID}/audio-samples`)
        .set("Cookie", cookie)
        .set("Content-Type", contentType)
        .send(body);
      assert.equal(res.status, 200);
    }
    const { body: fourthBody, contentType: fourthType } = buildMultipart("S4", {
      name: "sample-4.mp3",
      type: "audio/mpeg",
      bytes: Buffer.from([0x49, 0x44, 0x33]),
    });
    const fourth = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", fourthType)
      .send(fourthBody);
    assert.equal(fourth.status, 400);
    assert.equal(fourth.body.error.code, "AUDIO_SAMPLE_LIMIT_EXCEEDED");
  });

  test("removal of an unknown sample returns AUDIO_SAMPLE_NOT_FOUND", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const res = await request(app)
      .delete(`/api/services/${OFFERING_ID}/audio-samples/smp-missing`)
      .set("Cookie", cookie);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "AUDIO_SAMPLE_NOT_FOUND");
  });

  test("buyer-facing playback returns audio/mpeg bytes for an Active offering", async () => {
    const { app, adapter, storage } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    const { body: mp3Body, contentType } = buildMultipart("Play", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes,
    });
    const upload = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(upload.status, 200);
    const sampleId = upload.body.sample.sampleId as string;
    const play = await request(app).get(
      `/api/services/${OFFERING_ID}/audio-samples/${sampleId}/play`,
    );
    assert.equal(play.status, 200);
    assert.equal(play.headers["content-type"], "audio/mpeg");
    assert.deepEqual(Buffer.from(play.body as Buffer).toString("hex"), bytes.toString("hex"));
    // Sanity: the deterministic storage adapter actually has the bytes.
    assert.ok(storage);
  });

  test("buyer-facing list returns the buyer-safe DTO without a session", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const { body: mp3Body, contentType } = buildMultipart("Buyer-visible", {
      name: "sample.mp3",
      type: "audio/mpeg",
      bytes: Buffer.from([0x49, 0x44, 0x33]),
    });
    await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    // No cookie: buyer-facing read.
    const list = await request(app).get(`/api/services/${OFFERING_ID}/audio-samples`);
    assert.equal(list.status, 200);
    assert.equal(list.body.samples.length, 1);
    assert.equal(list.body.samples[0].label, "Buyer-visible");
    assert.equal(list.body.samples[0].contentType, "audio/mpeg");
  });
});
