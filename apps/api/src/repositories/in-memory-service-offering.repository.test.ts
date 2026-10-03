// In-memory ServiceOfferingRepository tests.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryServiceOfferingRepository } from "./in-memory-service-offering.repository.js";

const WS_ID = "ws_test";
const SELLER_PROFILE_ID = "sp_test";
const ACTIVATED_BY = "user_test_activator";

function buildRepo(): InMemoryServiceOfferingRepository {
  const repo = new InMemoryServiceOfferingRepository();
  repo._seedOffering({
    id: "of_a",
    workspaceId: WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: "Draft",
  });
  repo._seedOffering({
    id: "of_b",
    workspaceId: WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: "Draft",
  });
  return repo;
}

const playbackUrl = (input: { offeringId: string; sampleId: string }) =>
  `https://api.test/${input.offeringId}/${input.sampleId}/play`;

void describe("InMemoryServiceOfferingRepository", () => {
  void test("per-offering mutex chain does NOT poison after a rejected saveDraft", async () => {
    const repo = buildRepo();
    await assert.rejects(
      repo.saveDraft({
        offeringId: "of_missing",
        workspaceId: WS_ID,
        title: "x",
        description: "x",
        primaryCategoryKey: null,
        serviceMode: null,
        serviceAreas: [],
        pricing: null,
        genreTags: [],
        includedServiceCategoryKeys: [],
        now: new Date(),
        playbackUrlFor: playbackUrl,
      }),
      (err: unknown) => (err as Error).name === "ServiceOfferingNotFoundError",
    );
    const ok = await repo.saveDraft({
      offeringId: "of_a",
      workspaceId: WS_ID,
      title: "Title",
      description: "Description",
      primaryCategoryKey: null,
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: null,
      genreTags: [],
      includedServiceCategoryKeys: [],
      now: new Date(),
      playbackUrlFor: playbackUrl,
    });
    assert.equal(ok.serviceOfferingId, "of_a");
    assert.equal(ok.title, "Title");
  });

  // Codex/Tenki Blocker 2 — the in-memory adapter's
  // `toOwnerView` must NOT leak the internal `activatedByUserId`
  // through the human-facing `activatedByDisplayName` DTO field.
  // The Prisma adapter resolves the related `UserAccount.email`
  // via the OFFERING_INCLUDE join; the in-memory adapter has no
  // trustworthy human-readable value to surface, so it returns
  // `null` (contract-consistent parity). The internal
  // `activatedByUserId` remains available on the stored
  // activation row for authorization / evidence and is never
  // serialized to the OwnerView.
  void test("activatedByDisplayName never exposes the raw internal user ID; returns null instead", async () => {
    const repo = buildRepo();
    // Seed a CONFIRMED Live sample so the activation
    // completeness recheck (requires 1-3 Live samples) passes.
    repo._seedSample("of_a", {
      sampleId: "smp_b2",
      label: "Blocker 2 Demo",
      byteSize: 4096,
      displayOrder: 1,
      storageRef: "ref://blocker-2",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTIVATED_BY,
        confirmedAt: new Date(),
      },
    });
    const result = await repo.activate({
      offeringId: "of_a",
      workspaceId: WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      activatedByUserId: ACTIVATED_BY,
      title: "Title",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      requestId: "req-b2",
      playbackUrlFor: playbackUrl,
      now: new Date(),
    });
    // The activation MUST record the internal actor for
    // authorization / evidence — the field is preserved on
    // the stored activation row.
    // The stored activation evidence carries the internal
    // actor identifier (the same shape the Prisma adapter
    // persists on `service_offering_activations.activatedByUserId`).
    const storedActivations = repo._activationsForTest("of_a");
    assert.ok(storedActivations && storedActivations.length === 1);
    assert.equal(
      storedActivations[0]!.activatedByUserId,
      ACTIVATED_BY,
      "activation evidence must internally preserve the actor id",
    );
    // The OwnerView's `activatedByDisplayName` MUST NOT
    // expose that raw internal id. The previous
    // implementation assigned `row.activatedByUserId`
    // directly to the human-facing DTO field, leaking the
    // internal identifier. The fix returns `null` because
    // the in-memory store has no email / display-name to
    // resolve (parity with the Prisma path's
    // `latestActivation?.activatedBy?.email ?? null`).
    assert.equal(
      result.offering.activatedByDisplayName,
      null,
      "activatedByDisplayName must be null (never the raw internal user id)",
    );
    assert.notEqual(
      result.offering.activatedByDisplayName,
      ACTIVATED_BY,
      "activatedByDisplayName must NOT equal activatedByUserId — that would leak the internal id",
    );
    // Round-trip through the actual activation RESPONSE
    // schema (the route layer). The contract permits null;
    // any other value (e.g. a leaked user id) would either
    // fail the schema or — worse — succeed and expose the
    // internal identifier through a public DTO field.
    const { serviceOfferingActivationResponseV1Schema } = await import("@soundhub/types");
    const response = {
      ok: true as const,
      // Apply the service-layer Date→ISOString conversion
      // (`toResponseOwnerView`) so the response shape matches
      // the wire format the route layer sends. The repository
      // returns Date objects; the DTO requires ISO strings.
      offering: {
        ...result.offering,
        activatedAt: result.offering.activatedAt ? result.offering.activatedAt.toISOString() : null,
      },
      evidence: {
        ...result.evidence,
        activatedAt: result.evidence.activatedAt.toISOString(),
      },
      returnTo: null,
      safeReturnTo: null,
    };
    assert.doesNotThrow(
      () => serviceOfferingActivationResponseV1Schema.parse(response),
      "in-memory activation response must parse through serviceOfferingActivationResponseV1Schema",
    );
    assert.equal(
      serviceOfferingActivationResponseV1Schema.parse(response).offering.activatedByDisplayName,
      null,
      "in-memory OwnerView.activatedByDisplayName must be null per the DTO contract",
    );
  });
});

void describe("InMemoryServiceOfferingRepository — ServiceOfferingPause / ServiceOfferingReactivate (M2 #86, slice 86B)", () => {
  // Minimal SeedSample helper used by the Pause / Reactivate tests
  // below. CONFIRMED Live samples are required for Reactivate.
  function seedConfirmedLive(
    repo: InMemoryServiceOfferingRepository,
    offeringId: string,
    sampleId: string,
  ) {
    repo._seedSample(offeringId, {
      sampleId,
      label: sampleId,
      byteSize: 1024,
      displayOrder: 1,
      storageRef: `s3://bucket/${sampleId}`,
      cleanupStatus: "Live",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTIVATED_BY,
        confirmedAt: new Date("2026-09-27T12:00:00.000Z"),
      },
    });
  }

  // Pause requires the offering to be in Active state. This helper
  // seeds `of_a` as Active directly so each Pause test does not have
  // to drive a separate Activate dance. The existing `buildRepo()`
  // continues to seed Draft offerings for the legacy createDraft /
  // saveDraft / activate tests.
  function buildActiveRepo(): InMemoryServiceOfferingRepository {
    const repo = new InMemoryServiceOfferingRepository();
    repo._seedOffering({
      id: "of_a",
      workspaceId: WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    repo._seedOffering({
      id: "of_b",
      workspaceId: WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    // M2 (#86, slice 86B, Codex review fix): the Reactivate path
    // checks SellerProfile.published inside the repository. Register
    // the test SellerProfile as Published so the Reactivate tests
    // can pass; the "unpublished" test re-registers a Draft profile.
    repo._registerSellerProfile({
      workspaceId: WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Published",
    });
    return repo;
  }

  void describe("pause", () => {
    void test("Pause on Active flips status, writes pause evidence, returns OwnerView with status Paused", async () => {
      const repo = buildActiveRepo();
      const idempotencyKey = "11111111-2222-3333-4444-555555555555";
      const result = await repo.pause({
        offeringId: "of_a",
        workspaceId: WS_ID,
        pausedByUserId: ACTIVATED_BY,
        reason: "user_initiated",
        idempotencyKey,
        requestId: "req-1",
        now: new Date("2026-09-27T13:00:00.000Z"),
        playbackUrlFor: playbackUrl,
      });
      assert.equal(result.convergedFromExistingPause, false);
      assert.equal(result.offering.status, "Paused");
      assert.equal(result.evidence.reason, "user_initiated");
      assert.equal(result.evidence.idempotencyKey, idempotencyKey);
      assert.equal(result.evidence.pausedAt.toISOString(), "2026-09-27T13:00:00.000Z");
    });

    void test("Pause same-key retry converges on the existing pause row", async () => {
      const repo = buildActiveRepo();
      const idempotencyKey = "11111111-2222-3333-4444-555555555555";
      const first = await repo.pause({
        offeringId: "of_a",
        workspaceId: WS_ID,
        pausedByUserId: ACTIVATED_BY,
        reason: "user_initiated",
        idempotencyKey,
        requestId: "req-1",
        now: new Date("2026-09-27T13:00:00.000Z"),
        playbackUrlFor: playbackUrl,
      });
      const second = await repo.pause({
        offeringId: "of_a",
        workspaceId: WS_ID,
        pausedByUserId: ACTIVATED_BY,
        reason: "user_initiated",
        idempotencyKey,
        requestId: "req-2",
        now: new Date("2026-09-27T14:00:00.000Z"),
        playbackUrlFor: playbackUrl,
      });
      assert.equal(second.convergedFromExistingPause, true);
      assert.deepEqual(second.evidence, first.evidence);
      assert.equal(second.offering.status, "Paused");
    });

    void test("Pause different-key on Paused throws AlreadyPausedError", async () => {
      const repo = buildActiveRepo();
      await repo.pause({
        offeringId: "of_a",
        workspaceId: WS_ID,
        pausedByUserId: ACTIVATED_BY,
        reason: "user_initiated",
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
        requestId: "req-1",
        now: new Date("2026-09-27T13:00:00.000Z"),
        playbackUrlFor: playbackUrl,
      });
      await assert.rejects(
        repo.pause({
          offeringId: "of_a",
          workspaceId: WS_ID,
          pausedByUserId: ACTIVATED_BY,
          reason: "user_initiated",
          idempotencyKey: "22222222-3333-4444-5555-666666666666",
          requestId: "req-2",
          now: new Date("2026-09-27T14:00:00.000Z"),
          playbackUrlFor: playbackUrl,
        }),
        (err: unknown) => {
          assert.equal(
            (err as { name?: string }).name,
            "ServiceOfferingAlreadyPausedError",
            "different-key Pause on Paused must surface AlreadyPausedError",
          );
          return true;
        },
      );
    });

    void test("Pause on Draft throws NotActiveError with currentStatus=Draft", async () => {
      const repo = buildRepo();
      await assert.rejects(
        repo.pause({
          offeringId: "of_a",
          workspaceId: WS_ID,
          pausedByUserId: ACTIVATED_BY,
          reason: "user_initiated",
          idempotencyKey: "11111111-2222-3333-4444-555555555555",
          requestId: "req-1",
          now: new Date(),
          playbackUrlFor: playbackUrl,
        }),
        (err: unknown) => {
          const e = err as { name?: string; currentStatus?: string };
          assert.equal(e.name, "ServiceOfferingNotActiveError");
          assert.equal(e.currentStatus, "Draft");
          return true;
        },
      );
    });

    void test("Pause on a missing offering throws NotFoundError", async () => {
      const repo = buildActiveRepo();
      await assert.rejects(
        repo.pause({
          offeringId: "of_missing",
          workspaceId: WS_ID,
          pausedByUserId: ACTIVATED_BY,
          reason: "user_initiated",
          idempotencyKey: "11111111-2222-3333-4444-555555555555",
          requestId: "req-1",
          now: new Date(),
          playbackUrlFor: playbackUrl,
        }),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingNotFoundError");
          return true;
        },
      );
    });

    void test("Pause on a different Workspace throws NotOwnedError (route collapses to NOT_FOUND)", async () => {
      const repo = buildActiveRepo();
      await assert.rejects(
        repo.pause({
          offeringId: "of_a",
          workspaceId: "ws_other",
          pausedByUserId: ACTIVATED_BY,
          reason: "user_initiated",
          idempotencyKey: "11111111-2222-3333-4444-555555555555",
          requestId: "req-1",
          now: new Date(),
          playbackUrlFor: playbackUrl,
        }),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingNotOwnedError");
          return true;
        },
      );
    });

    void test("Pause persists the reason enum verbatim (final_sample_removal path)", async () => {
      const repo = buildActiveRepo();
      const result = await repo.pause({
        offeringId: "of_a",
        workspaceId: WS_ID,
        pausedByUserId: ACTIVATED_BY,
        reason: "final_sample_removal",
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
        requestId: "req-1",
        now: new Date(),
        playbackUrlFor: playbackUrl,
      });
      assert.equal(result.evidence.reason, "final_sample_removal");
    });
  });

  void describe("reactivate", () => {
    // Reactivate requires the offering to be in Paused state. The
    // setup helper re-seeds `of_a` directly as Paused so each test
    // does not have to drive a separate Activate + Pause dance. The
    // Pause tests above already cover the Pause precondition path.
    function buildPausedRepo(): InMemoryServiceOfferingRepository {
      const repo = new InMemoryServiceOfferingRepository();
      repo._seedOffering({
        id: "of_a",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Paused",
      });
      repo._seedOffering({
        id: "of_b",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Paused",
      });
      // M2 (#86, slice 86B, Codex review fix): register the
      // SellerProfile as Published so Reactivate precondition checks
      // can succeed; the unpublished-profile test re-registers a
      // Draft profile.
      repo._registerSellerProfile({
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Published",
      });
      return repo;
    }

    function minimalReactivate(
      overrides: Partial<Parameters<InMemoryServiceOfferingRepository["reactivate"]>[0]> = {},
    ) {
      return {
        offeringId: "of_a",
        workspaceId: WS_ID,
        reactivatedByUserId: ACTIVATED_BY,
        title: "Haitian dancehall production",
        description: "Arrangement + recording direction + editing.",
        primaryCategoryKey: "music-production",
        serviceMode: "Remote" as const,
        serviceAreas: [],
        pricing: {
          kind: "StartingAt" as const,
          amountMinor: 60000,
          currency: "USD",
          unitId: "per-track",
        },
        genreTags: [],
        includedServiceCategoryKeys: [],
        confirmationVersion: "m2-service-activation-v1" as const,
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
        requestId: "req-1",
        now: new Date("2026-09-27T13:00:00.000Z"),
        playbackUrlFor: playbackUrl,
        ...overrides,
      };
    }

    void test("Reactivate on Paused with full STRICT pass flips status, writes a new activation row, returns OwnerView with status Active", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      const result = await repo.reactivate(minimalReactivate({}));
      assert.equal(result.convergedFromExistingActivation, false);
      assert.equal(result.offering.status, "Active");
      assert.equal(result.evidence.activatedAt.toISOString(), "2026-09-27T13:00:00.000Z");
      assert.equal(result.evidence.confirmationVersion, "m2-service-activation-v1");
    });

    void test("Reactivate same-key retry converges on the existing activation row", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      const first = await repo.reactivate(minimalReactivate({}));
      const second = await repo.reactivate(
        minimalReactivate({
          now: new Date("2026-09-27T14:00:00.000Z"),
        }),
      );
      assert.equal(second.convergedFromExistingActivation, true);
      assert.deepEqual(second.evidence, first.evidence);
    });

    void test("Reactivate different-key on Active throws NotPausedError with currentStatus=Active", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      // First Reactivate succeeds and flips the offering to Active.
      await repo.reactivate(
        minimalReactivate({ idempotencyKey: "11111111-2222-3333-4444-666666666666" }),
      );
      // Second Reactivate with a DIFFERENT idempotencyKey against the
      // now-Active offering hits the NotPausedError precondition.
      await assert.rejects(repo.reactivate(minimalReactivate({})), (err: unknown) => {
        const e = err as { name?: string; currentStatus?: string };
        assert.equal(e.name, "ServiceOfferingNotPausedError");
        assert.equal(e.currentStatus, "Active");
        return true;
      });
    });

    void test("Reactivate on Draft throws NotPausedError with currentStatus=Draft", async () => {
      const repo = buildRepo(); // seeds of_a as Draft
      await assert.rejects(repo.reactivate(minimalReactivate({})), (err: unknown) => {
        const e = err as { name?: string; currentStatus?: string };
        assert.equal(e.name, "ServiceOfferingNotPausedError");
        assert.equal(e.currentStatus, "Draft");
        return true;
      });
    });

    void test("Reactivate with no CONFIRMED Live samples throws IncompleteError carrying samples_required", async () => {
      const repo = buildPausedRepo();
      // No seedConfirmedLive call — the offering has zero Live samples.
      await assert.rejects(repo.reactivate(minimalReactivate({})), (err: unknown) => {
        const e = err as {
          name?: string;
          fieldErrors?: Array<{ path: string; code: string }>;
        };
        assert.equal(e.name, "ServiceOfferingIncompleteError");
        assert.ok(
          e.fieldErrors?.some((f) => f.path === "samples" && f.code === "samples_required"),
          "IncompleteError must carry the samples_required field error",
        );
        return true;
      });
    });

    void test("Reactivate with missing primaryCategoryKey throws IncompleteError carrying category_required", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      await assert.rejects(
        repo.reactivate(minimalReactivate({ primaryCategoryKey: "" })),
        (err: unknown) => {
          const e = err as {
            name?: string;
            fieldErrors?: Array<{ path: string; code: string }>;
          };
          assert.equal(e.name, "ServiceOfferingIncompleteError");
          assert.ok(
            e.fieldErrors?.some(
              (f) => f.path === "primaryCategoryKey" && f.code === "category_required",
            ),
            "IncompleteError must carry the category_required field error",
          );
          return true;
        },
      );
    });

    void test("Reactivate cross-workspace throws NotOwnedError", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      await assert.rejects(
        repo.reactivate(minimalReactivate({ workspaceId: "ws_other" })),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingNotOwnedError");
          return true;
        },
      );
    });

    // M2 (#86, slice 86B Codex re-review): structural parity
    // coverage for the Reactivate workspaceLock acquisition. The
    // authoritative deterministic interleaving test lives in the
    // Prisma test file (the Postgres advisory lock is the only
    // artifact that can prove timing). This in-memory test verifies
    // that the Reactivate body acquires the SAME
    // `withWorkspaceLock(workspaceId, ...)` mutex chain that the
    // test-only `_suspendSellerProfileUnderLock` helper acquires —
    // so any future regression that drops the workspaceLock from
    // Reactivate would be caught by the FIFO ordering guarantee.
    void test("reactivate serializes against a concurrent suspension via the seller-profile workspaceLock", async () => {
      const repo = buildPausedRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");

      // Reactivate is called FIRST so it acquires the workspaceLock
      // first under Node.js FIFO microtask scheduling. The
      // concurrent suspension is forced to wait on the same
      // workspaceLock until Reactivate releases it.
      const reactivatePromise = repo.reactivate(minimalReactivate({}));
      const suspensionPromise = repo._suspendSellerProfileUnderLock(WS_ID, SELLER_PROFILE_ID);

      const [reactivateResult, suspensionResult] = await Promise.all([
        reactivatePromise,
        suspensionPromise,
      ]);

      // Reactivate won the workspaceLock first → completed Active
      // BEFORE the suspension ran. The profile was Published at the
      // time of Reactivate's publication check.
      assert.equal(reactivateResult.offering.status, "Active");
      assert.equal(reactivateResult.convergedFromExistingActivation, false);
      // The suspension ran AFTER Reactivate released the lock;
      // `_suspendSellerProfileUnderLock` returns the prior status
      // so the test can confirm it observed Published (the value
      // that was live when Reactivate committed).
      assert.equal(suspensionResult.previousStatus, "Published");
      assert.equal(repo._peekSellerProfileStatus(SELLER_PROFILE_ID), "Suspended");
    });
  });

  // ===========================================================================
  // M2 (#86, slice 86C): `updateActive` repository tests
  // ===========================================================================
  void describe("updateActive", () => {
    function buildActiveRepo(): InMemoryServiceOfferingRepository {
      const repo = new InMemoryServiceOfferingRepository();
      repo._seedOffering({
        id: "of_a",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Active",
      });
      repo._seedOffering({
        id: "of_b",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Active",
      });
      repo._registerSellerProfile({
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Published",
      });
      return repo;
    }

    function minimalUpdate(
      overrides: Partial<Parameters<InMemoryServiceOfferingRepository["updateActive"]>[0]> = {},
    ) {
      return {
        offeringId: "of_a",
        workspaceId: WS_ID,
        updatedByUserId: ACTIVATED_BY,
        title: "Updated title",
        description: "Updated description.",
        primaryCategoryKey: "music-production",
        serviceMode: "Remote" as const,
        serviceAreas: [],
        pricing: {
          kind: "StartingAt" as const,
          amountMinor: 75000,
          currency: "USD",
          unitId: "per-track",
        },
        genreTags: ["dancehall"],
        includedServiceCategoryKeys: [],
        confirmationVersion: "m2-service-activation-v1" as const,
        idempotencyKey: "22222222-3333-4444-5555-666666666666",
        requestId: "req-update-1",
        now: new Date("2026-09-27T15:00:00.000Z"),
        playbackUrlFor: playbackUrl,
        ...overrides,
      };
    }

    void test("updateActive on Active with full STRICT pass replaces the public field set atomically, appends ONE update row, and preserves the activation timestamp", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      // Capture the original activatedAt on the offering so we
      // can assert it is preserved verbatim by Update.
      const beforePeek = repo._peekOffering("of_a");
      const originalActivatedAt = beforePeek?.activatedAt ?? null;
      const originalActivatedByUserId = beforePeek?.activatedByUserId ?? null;

      const result = await repo.updateActive(minimalUpdate({ title: "New title after update" }));

      assert.equal(result.convergedFromExistingUpdate, false);
      assert.equal(result.offering.status, "Active");
      // Lifecycle did NOT change (slice 86C invariant).
      assert.equal(result.offering.status, "Active");
      // Public fields were replaced atomically.
      assert.equal(result.offering.title, "New title after update");
      assert.equal(result.offering.description, "Updated description.");
      // The activation timestamp on the OWNERVIEW is preserved
      // (the OwnerView derives `activatedAt` from the latest
      // ServiceOfferingActivation row, which Update never touches).
      assert.equal(result.offering.activatedAt, originalActivatedAt);
      assert.equal(
        JSON.stringify(result.offering.activatedAt),
        JSON.stringify(originalActivatedAt),
      );
      // Evidence carries the update timestamp + idempotency key.
      assert.equal(result.evidence.updatedAt.toISOString(), "2026-09-27T15:00:00.000Z");
      assert.equal(result.evidence.confirmationVersion, "m2-service-activation-v1");
      assert.equal(result.evidence.idempotencyKey, "22222222-3333-4444-5555-666666666666");

      // Internal: the underlying offering row's `activatedAt` and
      // `activatedByUserId` were NOT touched by Update — they
      // remain at the values the original activation committed.
      const afterPeek = repo._peekOffering("of_a");
      assert.equal(afterPeek?.activatedAt, originalActivatedAt);
      assert.equal(afterPeek?.activatedByUserId, originalActivatedByUserId);
    });

    void test("updateActive same-key retry converges on the existing update row", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      const first = await repo.updateActive(minimalUpdate({}));
      const second = await repo.updateActive(
        minimalUpdate({
          now: new Date("2026-09-27T16:00:00.000Z"),
        }),
      );
      assert.equal(second.convergedFromExistingUpdate, true);
      // The evidence row is the SAME one (the second call returns
      // the persisted evidence from the first call).
      assert.deepEqual(second.evidence, first.evidence);
    });

    void test("updateActive different-key on Paused throws UpdateNotActiveError", async () => {
      const repo = new InMemoryServiceOfferingRepository();
      repo._seedOffering({
        id: "of_a",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Paused",
      });
      repo._registerSellerProfile({
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Published",
      });
      await assert.rejects(repo.updateActive(minimalUpdate({})), (err: unknown) => {
        const e = err as { name?: string; currentStatus?: string };
        assert.equal(e.name, "ServiceOfferingUpdateNotActiveError");
        assert.equal(e.currentStatus, "Paused");
        return true;
      });
    });

    void test("updateActive different-key on Draft throws UpdateNotActiveError", async () => {
      const repo = new InMemoryServiceOfferingRepository();
      repo._seedOffering({
        id: "of_a",
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Draft",
      });
      repo._registerSellerProfile({
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Published",
      });
      await assert.rejects(repo.updateActive(minimalUpdate({})), (err: unknown) => {
        const e = err as { name?: string; currentStatus?: string };
        assert.equal(e.name, "ServiceOfferingUpdateNotActiveError");
        assert.equal(e.currentStatus, "Draft");
        return true;
      });
    });

    void test("updateActive on missing offering throws NotFoundError", async () => {
      const repo = buildActiveRepo();
      await assert.rejects(
        repo.updateActive(minimalUpdate({ offeringId: "of_missing" })),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingNotFoundError");
          return true;
        },
      );
    });

    void test("updateActive cross-workspace throws NotOwnedError", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      await assert.rejects(
        repo.updateActive(minimalUpdate({ workspaceId: "ws_other" })),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingNotOwnedError");
          return true;
        },
      );
    });

    void test("updateActive with no CONFIRMED Live samples throws InvalidUpdateError carrying samples_required", async () => {
      const repo = buildActiveRepo();
      // No seedConfirmedLive call — the offering has zero Live samples.
      await assert.rejects(repo.updateActive(minimalUpdate({})), (err: unknown) => {
        const e = err as {
          name?: string;
          fieldErrors?: Array<{ path: string; code: string }>;
        };
        assert.equal(e.name, "ServiceOfferingInvalidUpdateError");
        assert.ok(
          e.fieldErrors?.some((f) => f.path === "samples" && f.code === "samples_required"),
          "InvalidUpdateError must carry the samples_required field error",
        );
        return true;
      });
    });

    void test("updateActive with missing primaryCategoryKey throws InvalidUpdateError carrying category_required", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      await assert.rejects(
        repo.updateActive(minimalUpdate({ primaryCategoryKey: "" })),
        (err: unknown) => {
          const e = err as {
            name?: string;
            fieldErrors?: Array<{ path: string; code: string }>;
          };
          assert.equal(e.name, "ServiceOfferingInvalidUpdateError");
          assert.ok(
            e.fieldErrors?.some(
              (f) => f.path === "primaryCategoryKey" && f.code === "category_required",
            ),
            "InvalidUpdateError must carry the category_required field error",
          );
          return true;
        },
      );
    });

    void test("updateActive with unpublished SellerProfile throws SellerProfileNotPublishedError", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      // Re-register the SellerProfile as Draft (not Published).
      repo._registerSellerProfile({
        workspaceId: WS_ID,
        sellerProfileId: SELLER_PROFILE_ID,
        status: "Draft",
      });
      await assert.rejects(repo.updateActive(minimalUpdate({})), (err: unknown) => {
        assert.equal(
          (err as { name?: string }).name,
          "ServiceOfferingSellerProfileNotPublishedError",
        );
        return true;
      });
    });

    void test("updateActive failure preserves the prior public state (no field changes committed)", async () => {
      const repo = buildActiveRepo();
      seedConfirmedLive(repo, "of_a", "sample-1");
      const beforePeek = repo._peekOffering("of_a");
      const beforeTitle = beforePeek?.title;
      const beforeDescription = beforePeek?.description;
      // The update payload is missing the primaryCategoryKey, so
      // the repository's completeness recheck throws
      // InvalidUpdateError.
      await assert.rejects(
        repo.updateActive(minimalUpdate({ primaryCategoryKey: "" })),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "ServiceOfferingInvalidUpdateError");
          return true;
        },
      );
      // The offering's prior public state is preserved verbatim.
      const afterPeek = repo._peekOffering("of_a");
      assert.equal(afterPeek?.title, beforeTitle);
      assert.equal(afterPeek?.description, beforeDescription);
    });
  });
});
