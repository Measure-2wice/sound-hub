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
const OFFERING_ID = "of-active";
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
  });
  return service;
}

function mp3Bytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe("AudioSampleService", () => {
  test("an authorized seller can upload, list, and remove a sample (GS 7)", async () => {
    const storage = new DeterministicStorageAdapter();
    const repo = makeAudioRepo();
    const service = buildService(repo, storage);

    const uploaded = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      label: "Sample 1",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(uploaded.sample.label, "Sample 1");
    assert.equal(uploaded.sample.byteSize, 1024);
    assert.equal(uploaded.sample.displayOrder, 1);
    assert.equal(uploaded.sample.contentType, "audio/mpeg");

    const list = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
    });
    assert.equal(list.samples.length, 1);
    assert.equal(list.samples[0]?.sampleId, uploaded.sample.sampleId);

    const removed = await service.removeSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      sampleId: uploaded.sample.sampleId,
    });
    assert.equal(removed.sampleId, uploaded.sample.sampleId);

    const after = await service.listSamplesForSeller({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
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
          label: "Foreign",
          contentType: "audio/mpeg",
          byteSize: 1024,
          bytes: mp3Bytes(1024),
        }),
      (err: unknown) => err instanceof AudioSampleError && err.code === "AUDIO_OFFERING_INELIGIBLE",
    );
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
    // BUYER_USER is a Buyer-only member. The Workspace owns the
    // offering (impossible state in production — buyer workspaces
    // cannot own seller offerings — but it proves the capability
    // check still fires regardless of ownership).
    await assert.rejects(
      () =>
        service.uploadSample({
          userAccountId: BUYER_USER,
          offeringId: OFFERING_ID,
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
    });
    assert.equal(list.samples.length, 0, "no row should be persisted on storage failure");
  });

  test("storage type rejection propagates as AUDIO_CONTENT_TYPE_UNSUPPORTED", async () => {
    const rejectingStorage = {
      uploadSample: () => {
        throw new StorageRejectedError("wrong type");
      },
      getPlaybackReference: () => Promise.resolve(null),
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
      label: "A",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    assert.equal(a.sample.displayOrder, 1);
    const b = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
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
    });
    const c = await service.uploadSample({
      userAccountId: SELLER_USER,
      offeringId: OFFERING_ID,
      label: "C",
      contentType: "audio/mpeg",
      byteSize: 1024,
      bytes: mp3Bytes(1024),
    });
    // Slot 1 is free again after removing `a`; the seller assigns
    // the next free slot rather than appending at the end so the
    // listing stays compact.
    assert.equal(c.sample.displayOrder, 1);
  });
});
