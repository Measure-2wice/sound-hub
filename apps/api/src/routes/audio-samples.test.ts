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
const DUAL_USER_ID = "user-dual-member";
const DUAL_SELLER_WORKSPACE_ID = "ws-dual-seller";
const DUAL_BUYER_WORKSPACE_ID = "ws-dual-buyer";
const OFFERING_ID = "of-active";
const DUAL_OFFERING_ID = "of-dual-seller";

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
    // A user belonging to both a Seller-capable Workspace and a
    // Buyer-only Workspace. The route must reject commands that
    // pick the wrong acting workspace, even though the user has
    // membership on both workspaces.
    {
      userAccountId: DUAL_USER_ID,
      email: "dual-route@example.com",
      identityProvider: "deterministic",
      identitySubject: "dual-route-subject",
      memberships: [
        {
          workspaceId: DUAL_SELLER_WORKSPACE_ID,
          slug: "dual-seller",
          name: "Dual Seller Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
        {
          workspaceId: DUAL_BUYER_WORKSPACE_ID,
          slug: "dual-buyer",
          name: "Dual Buyer Workspace",
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
        offeringId: DUAL_OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: DUAL_SELLER_WORKSPACE_ID,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Dual member's offering",
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
  parts: {
    readonly actingWorkspaceId: string;
    readonly label: string;
    readonly file: { readonly name: string; readonly type: string; readonly bytes: Buffer };
  },
  extraFields: ReadonlyArray<{
    readonly name: string;
    readonly contentType?: string;
    readonly value: string;
  }> = [],
): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----SoundHubBG2Boundary${Math.random().toString(36).slice(2)}`;
  const buffers: Buffer[] = [];
  const writeField = (
    name: string,
    value: string,
    contentType?: string,
    filename?: string,
  ): void => {
    const head = [`--${boundary}\r\n`, `Content-Disposition: form-data; name="${name}"`];
    if (filename) head.push(`; filename="${filename}"`);
    head.push("\r\n");
    if (contentType) head.push(`Content-Type: ${contentType}\r\n`);
    head.push("\r\n");
    buffers.push(Buffer.from(head.join("")));
    buffers.push(Buffer.from(value, "utf8"));
    buffers.push(Buffer.from("\r\n"));
  };
  writeField("actingWorkspaceId", parts.actingWorkspaceId);
  writeField("label", parts.label);
  for (const extra of extraFields) {
    writeField(extra.name, extra.value, extra.contentType);
  }
  buffers.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${parts.file.name}"\r\n` +
        `Content-Type: ${parts.file.type}\r\n\r\n`,
    ),
  );
  buffers.push(parts.file.bytes);
  buffers.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(buffers),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("BG2 audio samples routes (in-memory, deterministic adapter)", () => {
  test("unauthenticated upload is rejected with SESSION_INVALID", async () => {
    const { app } = buildTestHarness();
    const { body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "L",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
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
    const { body: mp3Body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "Demo sample",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const upload = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.ok, true);
    assert.equal(upload.body.sample.label, "Demo sample");
    assert.equal(upload.body.sample.byteSize, 8);
    assert.equal(upload.body.sample.displayOrder, 1);
    assert.ok(upload.body.sample.playbackUrl);
    assert.equal("storageRef" in upload.body.sample, false);

    const list = await request(app)
      .get(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.samples.length, 1);
    assert.equal("storageRef" in list.body.samples[0], false);

    const remove = await request(app)
      .delete(`/api/services/${OFFERING_ID}/audio-samples/${upload.body.sample.sampleId}`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
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
    const { body: mp3Body, contentType } = buildMultipart({
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      label: "Foreign",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "AUDIO_OFFERING_INELIGIBLE");
  });

  test("a dual-Workspace member acting as the wrong workspace is rejected", async () => {
    // DUAL_USER belongs to both workspaces but the buyer workspace
    // does not own DUAL_OFFERING_ID. The server rejects even
    // though the user is a member of the supplied workspace.
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "dual-route@example.com");
    const { body: mp3Body, contentType } = buildMultipart({
      actingWorkspaceId: DUAL_BUYER_WORKSPACE_ID,
      label: "Cross-workspace",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const res = await request(app)
      .post(`/api/services/${DUAL_OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(mp3Body);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "AUDIO_OFFERING_INELIGIBLE");
    // Confirm: when the same user picks the seller workspace, the
    // upload succeeds (the seller workspace owns DUAL_OFFERING_ID).
    const { body: okBody, contentType: okType } = buildMultipart({
      actingWorkspaceId: DUAL_SELLER_WORKSPACE_ID,
      label: "Correct",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const okRes = await request(app)
      .post(`/api/services/${DUAL_OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", okType)
      .send(okBody);
    assert.equal(okRes.status, 200);
  });

  test("a non-MP3 object is rejected at the trusted boundary (GS 11)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const { body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "Bad",
      file: {
        name: "sample.wav",
        type: "audio/wav",
        bytes: Buffer.from([0x52, 0x49, 0x46]),
      },
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
    const { body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "Too big",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: oversize,
      },
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
      const { body, contentType } = buildMultipart({
        actingWorkspaceId: SELLER_WORKSPACE_ID,
        label: `S${i}`,
        file: {
          name: `sample-${i}.mp3`,
          type: "audio/mpeg",
          bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
        },
      });
      const res = await request(app)
        .post(`/api/services/${OFFERING_ID}/audio-samples`)
        .set("Cookie", cookie)
        .set("Content-Type", contentType)
        .send(body);
      assert.equal(res.status, 200);
    }
    const { body: fourthBody, contentType: fourthType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "S4",
      file: {
        name: "sample-4.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
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
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "AUDIO_SAMPLE_NOT_FOUND");
  });

  test("buyer-facing playback returns audio/mpeg bytes for an Active offering", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const { body: mp3Body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "Play",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes,
      },
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
  });

  test("buyer-facing list returns the buyer-safe DTO without a session", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const { body: mp3Body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: "Buyer-visible",
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
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
    assert.ok(list.body.samples[0].playbackUrl);
    assert.equal("storageRef" in list.body.samples[0], false);
  });

  test("a 120-character label is accepted (boundary OK)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const label120 = "a".repeat(120);
    const { body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: label120,
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.sample.label.length, 120);
  });

  test("a 121-character label is rejected with no storage/DB side effects (GS 11)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const label121 = "a".repeat(121);
    const { body, contentType } = buildMultipart({
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      label: label121,
      file: {
        name: "sample.mp3",
        type: "audio/mpeg",
        bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    });
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .send(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_AUTH_REQUEST");
    // Confirm no row was persisted (storage-first / row-after
    // ordering in AudioSampleService guarantees that a label
    // rejection at the trusted boundary leaves no row OR stored
    // object behind).
    const list = await request(app).get(`/api/services/${OFFERING_ID}/audio-samples`);
    assert.equal(list.body.samples.length, 0, "no row was persisted");
  });

  test("missing payload returns 400 BAD_REQUEST (not 413)", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    // Well-formed multipart body with zero parts: the parser sees
    // the opening + closing boundary and returns null. The route
    // returns AUDIO_PAYLOAD_MISSING mapped to 400 (Bad Request),
    // not 413 (Payload Too Large) — a missing payload is a
    // malformed-request rejection, distinct from a size cap.
    const boundary = "----SoundHubBG2BoundaryEmpty";
    const body = Buffer.from(`--${boundary}\r\n\r\n--${boundary}--\r\n`);
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "AUDIO_PAYLOAD_MISSING");
  });

  test("missing actingWorkspaceId in upload is rejected at the trusted boundary", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    // No actingWorkspaceId field — the multipart payload is well-
    // formed but the boundary rejects it.
    const boundary = "----SoundHubBG2BoundaryNoActing";
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="label"\r\n\r\n` +
        `Demo\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="sample.mp3"\r\n` +
        `Content-Type: audio/mpeg\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([
      head,
      Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
      tail,
    ]);
    const res = await request(app)
      .post(`/api/services/${OFFERING_ID}/audio-samples`)
      .set("Cookie", cookie)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_AUTH_REQUEST");
  });

  test("removal body must include actingWorkspaceId", async () => {
    const { app, adapter } = buildTestHarness();
    const cookie = await signIn(app, adapter, "seller-route@example.com");
    const res = await request(app)
      .delete(`/api/services/${OFFERING_ID}/audio-samples/smp-missing`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_AUTH_REQUEST");
  });
});
