// AudioSampleService tests.
//
// Background: ticket #61 pins the seller-audio slice against a
// focused test suite that exercises every authorization, limit, and
// persistence branch via the in-memory adapters. The service is the
// single owner of:
//   - WorkspaceMembership + Seller capability authorization (GS 4,
//     GS 8).
//   - Offering eligibility (Active + Published profile + Active
//     Workspace + Seller capability, GS 10).
//   - The 3-sample cap, MP3-only content type, and 25 MB cap
//     (GS 11).
//   - Storage-first / row-after ordering (GS 9).
//   - Removal ordering: row first, then storage object (GS 10).
//   - Explicit actingWorkspaceId on every consequential command
//     (ticket #61 follow-up review).
//
// Tests assert observable contract outcomes (return shape, error
// codes, persisted record count, storage adapter calls) rather than
// private helper functions.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AudioSampleService, AudioSampleError } from "./audio-sample.service.js";
import { InMemoryAudioRepository } from "../audio-repository/in-memory-audio-repository.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import { DeterministicStorageAdapter } from "../storage/deterministic-storage-adapter.js";
import { StorageRejectedError, StorageUnavailableError } from "../storage/storage-adapter.js";

const SELLER_USER = "user-buyer-seller";
const SELLER_WORKSPACE = "ws-buyer-seller";
const BUYER_USER = "user-buyer-other";
const BUYER_WORKSPACE = "ws-buyer-other";
const DUAL_USER = "user-dual-member";
const DUAL_SELLER_WORKSPACE = "ws-dual-seller";
const DUAL_BUYER_WORKSPACE = "ws-dual-buyer";
const OFFERING_ID = "of-active";
const DUAL_OFFERING_ID = "of-dual-seller";
const DRAFT_OFFERING_ID = "of-draft";
const SUSPENDED_OFFERING_ID = "of-suspended";

const ONE_MB = 1024 * 1024;

function makeAuthRepo() {
  return new InMemoryAuthRepository([
    {
      userAccountId: SELLER_USER,
      email: "seller@example.com",
      identityProvider: "deterministic",
      identitySubject: "seller-subject",
      memberships: [
        {
          workspaceId: SELLER_WORKSPACE,
          slug: "seller-workspace",
          name: "Seller Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
    {
      userAccountId: BUYER_USER,
      email: "buyer@example.com",
      identityProvider: "deterministic",
      identitySubject: "buyer-subject",
      memberships: [
        {
          workspaceId: BUYER_WORKSPACE,
          slug: "buyer-workspace",
          name: "Buyer Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Buyer"],
        },
      ],
    },
    // A user who belongs to both a Seller-capable Workspace and a
    // Buyer-only Workspace. Used to assert that membership in both
    // Workspaces cannot bypass the actingWorkspaceId ownership check
    // (ticket #61 P0-001 follow-up).
    {
      userAccountId: DUAL_USER,
      email: "dual@example.com",
      identityProvider: "deterministic",
      identitySubject: "dual-subject",
      memberships: [
        {
          workspaceId: DUAL_SELLER_WORKSPACE,
          slug: "dual-seller",
          name: "Dual Seller Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
        {
          workspaceId: DUAL_BUYER_WORKSPACE,
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
}

function makeAudioRepo() {
  return new InMemoryAudioRepository({
    offerings: [
      {
        offeringId: OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: SELLER_WORKSPACE,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Active offering",
      },
      {
        offeringId: DUAL_OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: DUAL_SELLER_WORKSPACE,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Dual member's offering",
      },
      {
        offeringId: DRAFT_OFFERING_ID,
        offeringStatus: "Draft",
        sellerProfileStatus: "Published",
        sellerWorkspaceId: SELLER_WORKSPACE,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Draft offering",
      },
      {
        offeringId: SUSPENDED_OFFERING_ID,
        offeringStatus: "Active",
        sellerProfileStatus: "Suspended",
        sellerWorkspaceId: SELLER_WORKSPACE,
        sellerWorkspaceStatus: "Active",
        hasSellerCapability: true,
        title: "Suspended profile offering",
      },
    ],
  });
}

function buildService(repo: InMemoryAudioRepository, storage: DeterministicStorageAdapter) {
  const authRepo = makeAuthRepo();
  const workspaceAuthorization = new WorkspaceAuthorizationService({ authRepository: authRepo });
  const service = new AudioSampleService({
    repository: repo,
    storage,
    workspaceAuthorization,
    publicApiBaseUrl: "http://api.example.test",
  });
  return service;
}

function mp3Bytes(size: number): Uint8Array {
  // Produce real MPEG audio frame sync (0xFF 0xFB) followed by
  // padding so the trusted boundary observes genuine MP3 content.
  const bytes = new Uint8Array(size);
  if (size >= 2) {
    bytes[0] = 0xff;
    bytes[1] = 0xfb;
  }
  return bytes;
}

describe("AudioSampleService", () => {
  test("an authorized seller can upload, list, and remove a sample (GS 7)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);

    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Sample 1",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(uploaded.sample.label, "Sample 1");
    assert.equal(uploaded.sample.byteSize, 1024);
    assert.equal(uploaded.sample.displayOrder, 1);
    assert.equal(uploaded.sample.contentType, "audio/mpeg");
    // The public DTO carries a playbackUrl but never a storageRef.
    assert.ok(uploaded.sample.playbackUrl);
    assert.equal(
      "storageRef" in uploaded.sample,
      false,
      "storageRef must not appear in the public DTO",
    );
    assert.ok(uploaded.sample.playbackUrl.includes(OFFERING_ID));

    const list = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(list.samples.length, 1);
    assert.equal(list.samples[0]?.sampleId, uploaded.sample.sampleId);

    const removed = await service.removeSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(removed.sampleId, uploaded.sample.sampleId);

    const after = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(after.samples.length, 0);
  });

  test("an unrelated Workspace cannot upload to a foreign offering (GS 8 / GS 4)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: BUYER_USER,
          offeringId: OFFERING_ID,
          // BUYER_USER's acting workspace is BUYER_WORKSPACE, which
          // does not own OFFERING_ID. The server rejects.
          actingWorkspaceId: BUYER_WORKSPACE,
          label: "Foreign",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
  });

  test("a dual-Workspace member cannot modify a stale offering under the wrong acting Workspace", async () => {
    // DUAL_USER belongs to both DUAL_SELLER_WORKSPACE and
    // DUAL_BUYER_WORKSPACE. They can only modify offerings owned
    // by the workspace they are currently acting for. Picking
    // the wrong acting workspace is rejected by the server even
    // though the user has the right membership role on both
    // workspaces.
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: DUAL_USER,
          offeringId: DUAL_OFFERING_ID,
          // Acting as the BUYER workspace, which does not own the
          // offering. The server rejects with
          // AUDIO_OFFERING_INELIGIBLE even though the user IS a
          // member of the BUYER workspace.
          actingWorkspaceId: DUAL_BUYER_WORKSPACE,
          label: "Cross-workspace attempt",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
    // Confirm the dual user CAN upload when acting as the correct
    // workspace (the seller workspace that owns DUAL_OFFERING_ID).
    const ok = await service.uploadSample({
      userAccountId: DUAL_USER,
      offeringId: DUAL_OFFERING_ID,
      actingWorkspaceId: DUAL_SELLER_WORKSPACE,
      label: "Correctly acting",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.ok(ok.sample.playbackUrl);
  });

  test("a member without Seller capability cannot upload (GS 8)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = new InMemoryAudioRepository({
      offerings: [
        {
          offeringId: OFFERING_ID,
          offeringStatus: "Active",
          sellerProfileStatus: "Published",
          sellerWorkspaceId: BUYER_WORKSPACE,
          sellerWorkspaceStatus: "Active",
          hasSellerCapability: true,
          title: "Active offering owned by buyer workspace",
        },
      ],
    });
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: BUYER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: BUYER_WORKSPACE,
          label: "Buyer attempt",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
  });

  test("a fourth sample is rejected (GS 11)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    for (let i = 1; i <= 3; i += 1) {
      await service.uploadSample({
        userAccountId: SELLER_USER,
        offeringId: OFFERING_ID,
        actingWorkspaceId: SELLER_WORKSPACE,
        label: `Sample ${i}`,
        contentType: "audio/mpeg",
        byteSize: 1024,
        bytes: mp3Bytes(1024),
      });
    }
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Sample 4",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) =>
        err instanceof AudioSampleError && err.code === "AUDIO_SAMPLE_LIMIT_EXCEEDED",
    );
  });

  test("a non-MP3 object is rejected at the trusted boundary (GS 11)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Bad",
          contentType: "audio/wav",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) =>
        err instanceof AudioSampleError && err.code === "AUDIO_CONTENT_TYPE_UNSUPPORTED",
    );
  });

  test("a sample larger than 25 MB is rejected at the trusted boundary (GS 11)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    const oversize = 25 * ONE_MB + 1;
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Big",
          contentType: "audio/mpeg",
          byteSize: oversize,
          bytes: mp3Bytes(oversize),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_PAYLOAD_TOO_LARGE",
    );
  });

  test("a draft offering cannot carry discovery samples (GS 10)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: DRAFT_OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Draft",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
  });

  test("a suspended profile offering cannot carry discovery samples (GS 10)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: SUSPENDED_OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Suspended",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
  });

  test("removal stops the sample from appearing in buyer-facing discovery (GS 10)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Sample",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    const before = await service.listSamplesForBuyer(OFFERING_ID);
    assert.equal(before.samples.length, 1);
    await service.removeSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    const after = await service.listSamplesForBuyer(OFFERING_ID);
    assert.equal(after.samples.length, 0);
  });

  test("removal of an unknown sample returns AUDIO_SAMPLE_NOT_FOUND", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.removeSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          sampleId: "smp-missing",
          actingWorkspaceId: SELLER_WORKSPACE,
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_SAMPLE_NOT_FOUND",
    );
  });

  test("storage failure removes no row (GS 9)", async () => {
    const failingStorage = {
      uploadSample: () => {
        throw new StorageUnavailableError("network");
      },
      getPlaybackReference: () => Promise.resolve(null),
      getPlaybackBytes: () => Promise.resolve(new Uint8Array()),
      removeSample: () => Promise.resolve(),
    };
    const repo = makeAudioRepo();
    const service = new AudioSampleService({
      repository: repo,
      storage: failingStorage,
      workspaceAuthorization: new WorkspaceAuthorizationService({
        authRepository: makeAuthRepo(),
      }),
    });
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Failing",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) =>
        err instanceof AudioSampleError && err.code === "AUDIO_PROVIDER_UNAVAILABLE",
    );
    const list = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(list.samples.length, 0, "no row should be persisted on storage failure");
  });

  test("storage type rejection propagates as AUDIO_CONTENT_TYPE_UNSUPPORTED", async () => {
    const rejectingStorage = {
      uploadSample: () => {
        throw new StorageRejectedError("wrong type");
      },
      getPlaybackReference: () => Promise.resolve(null),
      getPlaybackBytes: () => Promise.resolve(new Uint8Array()),
      removeSample: () => Promise.resolve(),
    };
    const repo = makeAudioRepo();
    const service = new AudioSampleService({
      repository: repo,
      storage: rejectingStorage,
      workspaceAuthorization: new WorkspaceAuthorizationService({
        authRepository: makeAuthRepo(),
      }),
    });
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Bad",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) =>
        err instanceof AudioSampleError && err.code === "AUDIO_CONTENT_TYPE_UNSUPPORTED",
    );
  });

  test("display order picks the smallest free slot so removal + re-upload keeps order", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    const a = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "A",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(a.sample.displayOrder, 1);
    const b = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "B",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(b.sample.displayOrder, 2);
    await service.removeSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      sampleId: a.sample.sampleId,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    const c = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "C",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(c.sample.displayOrder, 1);
  });

  test("buyer list exposes a playback URL but never a storageRef", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Privacy",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    const list = await service.listSamplesForBuyer(OFFERING_ID);
    assert.equal(list.samples.length, 1);
    const publicSample = list.samples[0]!;
    assert.ok(publicSample.playbackUrl);
    assert.equal("storageRef" in publicSample, false, "storageRef must never cross the public DTO");
    // Playback URL points to the in-app route composed by the
    // service from its configured `publicApiBaseUrl`. No Supabase
    // URL or bucket name leaks.
    assert.ok(publicSample.playbackUrl.startsWith("http://api.example.test/api/services/"));
    assert.equal(publicSample.playbackUrl.includes("supa:"), false);
    assert.equal(publicSample.playbackUrl.includes("token="), false);
  });

  test("missing or empty actingWorkspaceId is rejected at the trusted boundary", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: "",
          label: "Bad",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "INVALID_AUTH_REQUEST",
    );
  });

  test("P1-003: non-MP3 content disguised as audio/mpeg is rejected before storage", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    // Plain ASCII text declared as audio/mpeg. The trusted boundary
    // observes the bytes and rejects: no ID3 tag, no MPEG frame
    // sync word.
    const textBytes = Buffer.from("This is plain text, not MP3 audio.", "utf8");
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          actingWorkspaceId: SELLER_WORKSPACE,
          label: "Disguised",
          contentType: "audio/mpeg",
          byteSize: textBytes.length,
          bytes: textBytes,
        }),
      (err: unknown) =>
        err instanceof AudioSampleError && err.code === "AUDIO_CONTENT_TYPE_UNSUPPORTED",
    );
    const list = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(list.samples.length, 0);
  });

  test("P1-003: a real MP3 frame sync header passes the content check", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    // MPEG audio frame sync: 11 bits set (0xFFE_). The next byte's
    // top 3 bits are part of the sync too (0b111). Combined: bytes
    // 0xFF 0xFB form a valid MP3 frame sync word.
    const mp3Bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Real MP3",
      contentType: "audio/mpeg",
      byteSize: mp3Bytes.length,
      bytes: mp3Bytes,
    });
    assert.ok(uploaded.sample);
  });

  test("P1-004: two concurrent uploads starting from two existing samples cannot create four rows", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    // Seed two existing samples so the offering is at cap-1.
    for (let i = 1; i <= 2; i += 1) {
      await service.uploadSample({
        userAccountId: SELLER_USER,
        offeringId: OFFERING_ID,
        actingWorkspaceId: SELLER_WORKSPACE,
        label: `Existing ${i}`,
        contentType: "audio/mpeg",
        byteSize: 1024,
        bytes: mp3Bytes(1024),
      });
    }
    const mp3 = (): Uint8Array => new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
    // Two uploads race from cap-1. Exactly one wins; the other gets
    // AUDIO_SAMPLE_LIMIT_EXCEEDED.
    const results = await Promise.allSettled([
      service.uploadSample({
        userAccountId: SELLER_USER,
        offeringId: OFFERING_ID,
        actingWorkspaceId: SELLER_WORKSPACE,
        label: "Race A",
        contentType: "audio/mpeg",
        byteSize: 8,
        bytes: mp3(),
      }),
      service.uploadSample({
        userAccountId: SELLER_USER,
        offeringId: OFFERING_ID,
        actingWorkspaceId: SELLER_WORKSPACE,
        label: "Race B",
        contentType: "audio/mpeg",
        byteSize: 8,
        bytes: mp3(),
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const rejection = rejected[0];
    assert.ok(rejection);
    assert.ok(rejection.reason instanceof AudioSampleError);
    assert.equal(rejection.reason.code, "AUDIO_SAMPLE_LIMIT_EXCEEDED");
    const list = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    assert.equal(list.samples.length, 3, "live row count remains at the cap");
    assert.ok(
      list.samples.every((s) => s.displayOrder >= 1 && s.displayOrder <= 3),
      "display order stays within 1..3",
    );
  });

  test("P1-005: storage removal failure surfaces AUDIO_STORAGE_FAILED and hides the sample from discovery", async () => {
    const callCount = { remove: 0 };
    const flakyStorage = {
      uploadSample: (
        input: Parameters<typeof DeterministicStorageAdapter.prototype.uploadSample>[0],
      ): ReturnType<typeof DeterministicStorageAdapter.prototype.uploadSample> => {
        // Use the deterministic adapter under the hood so the seed
        // row is in PostgreSQL; we then override removeSample to
        // simulate a provider outage.
        const inner = new DeterministicStorageAdapter();
        return inner.uploadSample(input);
      },
      getPlaybackReference: (
        input: Parameters<typeof DeterministicStorageAdapter.prototype.getPlaybackReference>[0],
      ): ReturnType<typeof DeterministicStorageAdapter.prototype.getPlaybackReference> => {
        const inner = new DeterministicStorageAdapter();
        return inner.getPlaybackReference(input);
      },
      getPlaybackBytes: (
        ref: string,
      ): ReturnType<typeof DeterministicStorageAdapter.prototype.getPlaybackBytes> => {
        const inner = new DeterministicStorageAdapter();
        return inner.getPlaybackBytes(ref);
      },
      removeSample: (
        ref: string,
      ): ReturnType<typeof DeterministicStorageAdapter.prototype.removeSample> => {
        void ref;
        callCount.remove += 1;
        throw new StorageUnavailableError("provider down");
      },
    };
    const repo = makeAudioRepo();
    const service = new AudioSampleService({
      repository: repo,
      // The in-memory stub doesn't implement the full
      // StorageAdapter surface (no getPlaybackBytes etc.); the `as
      // never` cast crosses the partial boundary without an
      // explicit `unknown` indirection.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      storage: flakyStorage as never,
      workspaceAuthorization: new WorkspaceAuthorizationService({
        authRepository: makeAuthRepo(),
      }),
    });
    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Will fail to remove",
      contentType: "audio/mpeg",
      byteSize: 8,
      bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
    });
    await assert.rejects(
      () =>
        service.removeSample({
          userAccountId: SELLER_USER,
          offeringId: OFFERING_ID,
          sampleId: uploaded.sample.sampleId,
          actingWorkspaceId: SELLER_WORKSPACE,
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_STORAGE_FAILED",
    );
    assert.ok(callCount.remove >= 1);
    // The sample must be hidden from discovery immediately.
    const list = await service.listSamplesForBuyer(OFFERING_ID);
    assert.equal(
      list.samples.find((s) => s.sampleId === uploaded.sample.sampleId),
      undefined,
    );
  });

  test("P0-001 + P1-001: playback URL never exposes bucket, path, or storage ref", async () => {
    const storage = new DeterministicStorageAdapter({
      playbackBaseUrl: "http://api.example.test",
    });
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Privacy",
      contentType: "audio/mpeg",
      byteSize: 8,
      bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
    });
    const url = uploaded.sample.playbackUrl;
    assert.ok(url.startsWith("http://api.example.test/api/services/"));
    assert.ok(url.endsWith("/audio-samples/" + uploaded.sample.sampleId + "/play"));
    assert.equal(url.includes("storageRef"), false);
    assert.equal(url.includes("supa:"), false);
    assert.equal(url.includes("token="), false);
    // `storageRef` never appears on the public DTO.
    assert.equal("storageRef" in uploaded.sample, false);
  });

  test("P0-001: a removed sample's playback route returns AUDIO_SAMPLE_NOT_FOUND (eligibility re-check)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);
    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      actingWorkspaceId: SELLER_WORKSPACE,
      label: "Play me then remove me",
      contentType: "audio/mpeg",
      byteSize: 8,
      bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
    });
    const playback = await service.getBytesForPlayback({
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
    });
    assert.ok(playback);
    assert.equal(playback.bytes.length, 8);
    await service.removeSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
      actingWorkspaceId: SELLER_WORKSPACE,
    });
    const after = await service.getBytesForPlayback({
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
    });
    assert.equal(after, null, "playback route returns null after removal");
  });
});
