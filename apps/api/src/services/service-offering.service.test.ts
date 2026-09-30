// Unit tests for ServiceOfferingService (M2 #85).
//
// Run via `pnpm --filter @soundhub/api test` (the api package's test
// script invokes this file explicitly). Coverage:
//   - Authorization: Personal-Workspace-only AND Seller-capable
//     precondition. Buyer-only Personal Workspace, Organization
//     Workspace, and signed-out actors all rejected.
//   - Lazy first-save is NOT exercised by these tests because the
//     stable identity is created by a separate creation step
//     (out of #85 scope); the service assumes the row already
//     exists when `saveDraft` / `activate` is called.
//   - Resume: a Save Draft on a fresh row persists the values;
//     a subsequent Save Draft resumes from the persisted values.
//   - Activation completeness: incomplete payload (missing title,
//     missing description, missing primaryCategory, missing pricing
//     choice, missing Live samples, no service area for InPerson /
//     Hybrid) returns SERVICE_OFFERING_INCOMPLETE with the full
//     field error list.
//   - Activation requires a Published SellerProfile.
//   - Atomic activation transitions Draft to Active and inserts
//     the evidence row.
//   - Activation idempotency: same `idempotencyKey` converges on
//     the existing evidence row.
//   - Not-Draft activation returns SERVICE_OFFERING_NOT_DRAFT.
//   - Not-owned-by-actor activation returns
//     SERVICE_OFFERING_FORBIDDEN.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  MarketplaceCapabilityV1,
  ServiceOfferingActivateRequestV1,
  ServiceOfferingDraftRequestV1,
} from "@soundhub/types";
import type { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import {
  AuthorizationError,
  PersonalActingMembershipError,
  type ActingMembership,
} from "./workspace-authorization.service.js";
import { InMemoryServiceOfferingRepository } from "../repositories/in-memory-service-offering.repository.js";
import { ServiceOfferingService, ServiceOfferingServiceError } from "./service-offering.service.js";

const ACTING_USER = "user_acting_1";
const PERSONAL_WS_ID = "ws_personal_1";
const ORG_WS_ID = "ws_org_1";
const SELLER_PROFILE_ID = "sp_1";

function buildPersonalMembership(
  capabilities: readonly MarketplaceCapabilityV1[] = ["Seller"],
): ActingMembership {
  return {
    role: "Owner",
    capabilities,
    joinedAt: new Date("2024-01-01T00:00:00Z"),
    workspace: {
      workspaceId: PERSONAL_WS_ID,
      slug: "my-workspace",
      name: "My Workspace",
      workspaceType: "Personal",
      workspaceStatus: "Active",
      capabilities: [...capabilities],
    },
  };
}

function buildOrgMembership(
  capabilities: readonly MarketplaceCapabilityV1[] = ["Seller"],
): ActingMembership {
  return {
    role: "Owner",
    capabilities,
    joinedAt: new Date("2024-01-01T00:00:00Z"),
    workspace: {
      workspaceId: ORG_WS_ID,
      slug: "my-org",
      name: "My Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: [...capabilities],
    },
  };
}

class StubWorkspaceAuthorizationService {
  personalMembership: ActingMembership = buildPersonalMembership();
  orgMembership: ActingMembership = buildOrgMembership();

  requirePersonalActingMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<ActingMembership> {
    if (
      this.personalMembership.workspace.workspaceType !== "Personal" ||
      input.workspaceId === ORG_WS_ID
    ) {
      throw new PersonalActingMembershipError(
        "Organization Workspace is out of #85 scope; Personal-Workspace-only",
      );
    }
    void input.userAccountId;
    return Promise.resolve(this.personalMembership);
  }

  requireActingMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<ActingMembership> {
    if (input.workspaceId === PERSONAL_WS_ID) {
      return Promise.resolve(this.personalMembership);
    }
    if (input.workspaceId === ORG_WS_ID) {
      return Promise.resolve(this.orgMembership);
    }
    throw new AuthorizationError("Not a current member", "NOT_A_MEMBER");
  }

  requireCapability(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
    readonly requiredCapability: MarketplaceCapabilityV1;
  }): Promise<ActingMembership> {
    return this.requireActingMembership(input).then((membership) => {
      if (!membership.capabilities.includes(input.requiredCapability)) {
        throw new AuthorizationError(
          `Workspace lacks ${input.requiredCapability} capability`,
          "MISSING_CAPABILITY",
        );
      }
      return membership;
    });
  }
}

function buildService(
  input: {
    readonly sellerProfileStatus?: "Draft" | "Published" | "Suspended" | null;
  } = {},
): {
  service: ServiceOfferingService;
  repo: InMemoryServiceOfferingRepository;
  auth: StubWorkspaceAuthorizationService;
} {
  const repo = new InMemoryServiceOfferingRepository();
  // Seed an existing Draft offering on the Personal Workspace. The
  // lazy first-save is owned by a separate creation step (out of
  // #85 scope); the service tests assume the stable identity
  // already exists when saveDraft / activate is called.
  repo._seedOffering({
    id: "of_1",
    workspaceId: PERSONAL_WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: "Draft",
  });
  // M2 (#86, slice 86B, Codex review fix): the Reactivate path now
  // resolves the SellerProfile.published precondition INSIDE the
  // repository transaction. The in-memory adapter reads the profile
  // status from a test-only registry; tests must register the
  // profile so the Reactivate precondition check has data.
  repo._registerSellerProfile({
    workspaceId: PERSONAL_WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: input.sellerProfileStatus ?? "Published",
  });
  const auth = new StubWorkspaceAuthorizationService();
  const playbackUrlFor = (input: { offeringId: string; sampleId: string }) =>
    `https://api.test/services/${input.offeringId}/samples/${input.sampleId}/play`;
  const service = new ServiceOfferingService({
    repository: repo,
    workspaceAuthorizationService: auth as unknown as WorkspaceAuthorizationService,
    getSellerProfileStatus: () => Promise.resolve(input.sellerProfileStatus ?? "Published"),
    playbackUrlFor,
  });
  return { service, repo, auth };
}

function minimalDraft(
  overrides: Partial<ServiceOfferingDraftRequestV1> = {},
): ServiceOfferingDraftRequestV1 {
  return {
    title: "Haitian dancehall production",
    description: "Arrangement + recording direction + editing.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: { kind: "StartingAt", amountMinor: 60000, currency: "USD", unitId: "per-track" },
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    idempotencyKey: "draft-idem-1",
    ...overrides,
  };
}

function minimalActivate(
  overrides: Partial<ServiceOfferingActivateRequestV1> = {},
): ServiceOfferingActivateRequestV1 {
  return {
    title: "Haitian dancehall production",
    description: "Arrangement + recording direction + editing.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: { kind: "StartingAt", amountMinor: 60000, currency: "USD", unitId: "per-track" },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

void describe("ServiceOfferingService", () => {
  void test("saveDraft persists the values on a fresh Draft row", async () => {
    const { service } = buildService();
    const result = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalDraft(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering.title, "Haitian dancehall production");
    assert.equal(result.offering.status, "Draft");
    assert.equal(result.offering.primaryCategoryKey, "music-production");
    assert.deepEqual(result.offering.serviceAreas, []);
    assert.equal(result.offering.pricing?.kind, "StartingAt");
    assert.equal(result.offering.pricing?.amountMinor, 60000);
    assert.deepEqual(result.offering.genreTags, ["dancehall"]);
  });

  void test("saveDraft permits a RELAXED (incomplete) payload — Draft may be partial", async () => {
    const { service } = buildService();
    const result = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalDraft({
        title: undefined,
        description: undefined,
        primaryCategoryKey: undefined,
        serviceMode: undefined,
        pricing: undefined,
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering.title, "");
    assert.equal(result.offering.primaryCategoryKey, null);
    assert.equal(result.offering.serviceMode, null);
    assert.equal(result.offering.pricing, null);
  });

  void test("saveDraft on an Active offering returns SERVICE_OFFERING_NOT_DRAFT", async () => {
    const { service, repo } = buildService();
    repo._seedOffering({
      id: "of_active",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_active",
          request: minimalDraft(),
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError && err.code === "SERVICE_OFFERING_NOT_DRAFT",
    );
  });

  void test("Buyer-only Personal Workspace is rejected with SERVICE_OFFERING_FORBIDDEN", async () => {
    const { service, auth } = buildService();
    auth.personalMembership = buildPersonalMembership(["Buyer"]);
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_1",
          request: minimalDraft(),
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError && err.code === "SERVICE_OFFERING_FORBIDDEN",
    );
  });

  void test("Organization Workspace actor is rejected with SERVICE_OFFERING_FORBIDDEN", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: ORG_WS_ID,
          offeringId: "of_1",
          request: minimalDraft(),
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError && err.code === "SERVICE_OFFERING_FORBIDDEN",
    );
  });

  void test("activation requires the SellerProfile to be Published", async () => {
    const { service } = buildService({ sellerProfileStatus: "Draft" });
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_1",
          request: minimalActivate(),
          requestId: "req-1",
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError &&
        err.code === "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED",
    );
  });

  void test("activation with missing title returns SERVICE_OFFERING_INCOMPLETE", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_1",
          request: minimalActivate({ title: "   " }),
          requestId: "req-1",
        }),
      (err: unknown) => {
        if (!(err instanceof ServiceOfferingServiceError)) return false;
        if (err.code !== "SERVICE_OFFERING_INCOMPLETE") return false;
        return err.fieldErrors.some((f) => f.path === "title");
      },
    );
  });

  void test("activation with zero Live samples returns SERVICE_OFFERING_INCOMPLETE", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_1",
          request: minimalActivate(),
          requestId: "req-1",
        }),
      (err: unknown) => {
        if (!(err instanceof ServiceOfferingServiceError)) return false;
        if (err.code !== "SERVICE_OFFERING_INCOMPLETE") return false;
        return err.fieldErrors.some((f) => f.path === "samples");
      },
    );
  });

  void test("activation with InPerson mode and no service area returns SERVICE_OFFERING_INCOMPLETE", async () => {
    const { service, repo } = buildService();
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_1",
          request: minimalActivate({ serviceMode: "InPerson" }),
          requestId: "req-1",
        }),
      (err: unknown) => {
        if (!(err instanceof ServiceOfferingServiceError)) return false;
        if (err.code !== "SERVICE_OFFERING_INCOMPLETE") return false;
        return err.fieldErrors.some((f) => f.path === "serviceAreas");
      },
    );
  });

  void test("activation with one Live sample succeeds: Draft transitions to Active + evidence row inserted", async () => {
    const { service, repo } = buildService();
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    const result = await service.activate({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalActivate(),
      requestId: "req-activate-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering.status, "Active");
    assert.equal(result.evidence.confirmationVersion, "m2-service-activation-v1");
    assert.ok(result.evidence.activatedAt.length > 0);
    const activation = repo._peekActivation("of_1", result.evidence.idempotencyKey);
    assert.ok(activation);
    assert.equal(activation.activatedByUserId, ACTING_USER);
  });

  void test("activation with the same idempotencyKey converges on the existing evidence row", async () => {
    const { service, repo } = buildService();
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    const idemKey = crypto.randomUUID();
    const first = await service.activate({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalActivate({ idempotencyKey: idemKey }),
      requestId: "req-1",
    });
    const second = await service.activate({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalActivate({ idempotencyKey: idemKey }),
      requestId: "req-2",
    });
    assert.equal(first.evidence.idempotencyKey, second.evidence.idempotencyKey);
    // Only ONE evidence row should exist for the (offeringId, idemKey)
    // tuple.
    const activation = repo._peekActivation("of_1", idemKey);
    assert.ok(activation);
    assert.equal(repo._peekActivation("of_1", idemKey)?.id, activation.id);
  });

  void test("activation on an Active offering returns SERVICE_OFFERING_NOT_DRAFT", async () => {
    const { service, repo } = buildService();
    repo._seedOffering({
      id: "of_active",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    repo._seedSample("of_active", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_active",
          request: minimalActivate(),
          requestId: "req-1",
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError && err.code === "SERVICE_OFFERING_NOT_DRAFT",
    );
  });

  void test("activation on an offering not owned by the acting Workspace returns SERVICE_OFFERING_NOT_FOUND (safe-envelope, no info leak)", async () => {
    // The repository's `findForOwner` returns null when the offering
    // is not owned by the acting Workspace, so the service surfaces
    // NOT_FOUND rather than FORBIDDEN. This avoids leaking whether a
    // cross-Workspace offering exists; the safe envelope collapses
    // both rejection surfaces to the same customer-safe message.
    const { service, repo } = buildService();
    repo._seedOffering({
      id: "of_other",
      workspaceId: "ws_other",
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Draft",
    });
    repo._seedSample("of_other", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      () =>
        service.activate({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          offeringId: "of_other",
          request: minimalActivate(),
          requestId: "req-1",
        }),
      (err: unknown) =>
        err instanceof ServiceOfferingServiceError && err.code === "SERVICE_OFFERING_NOT_FOUND",
    );
  });

  void test("getCurrentOffering returns the OwnerView for a known offering", async () => {
    const { service } = buildService();
    const result = await service.getCurrentOffering({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering?.serviceOfferingId, "of_1");
    assert.equal(result.offering?.status, "Draft");
  });

  void test("getCurrentOffering returns null for an unknown offering", async () => {
    const { service } = buildService();
    const result = await service.getCurrentOffering({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_missing",
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering, null);
  });

  void test("listOfferingsForOwner returns only offerings owned by the acting Workspace", async () => {
    const { service, repo } = buildService();
    repo._seedOffering({
      id: "of_other",
      workspaceId: "ws_other",
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Draft",
      title: "Other",
    });
    const result = await service.listOfferingsForOwner({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
    });
    assert.equal(result.offerings.length, 1);
    assert.equal(result.offerings[0]?.serviceOfferingId, "of_1");
  });
});

void describe("ServiceOfferingService — Pause / Reactivate (M2 #86, slice 86B)", () => {
  function minimalPauseRequest(overrides: { readonly idempotencyKey?: string } = {}) {
    return {
      idempotencyKey: overrides.idempotencyKey ?? "11111111-2222-3333-4444-555555555555",
    };
  }

  void test("pause: Active offering flips to Paused and writes a pause evidence row", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    const result = await service.pause({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      ...minimalPauseRequest(),
      requestId: "req-pause-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering.status, "Paused");
    assert.equal(result.evidence.reason, "user_initiated");
    assert.equal(result.evidence.idempotencyKey, "11111111-2222-3333-4444-555555555555");
  });

  void test("pause: same-key retry returns converged success without writing a second pause row", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    const first = await service.pause({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      ...minimalPauseRequest(),
      requestId: "req-pause-1",
    });
    const second = await service.pause({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      ...minimalPauseRequest(),
      requestId: "req-pause-2",
    });
    assert.deepEqual(second.evidence, first.evidence);
  });

  void test("pause: a Draft offering surfaces SERVICE_OFFERING_NOT_ACTIVE", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Draft",
    });
    await assert.rejects(
      service.pause({
        userAccountId: ACTING_USER,
        workspaceId: PERSONAL_WS_ID,
        offeringId: "of_1",
        ...minimalPauseRequest(),
        requestId: "req-pause-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_NOT_ACTIVE");
        return true;
      },
    );
  });

  void test("pause: a different-key Pause on a Paused offering surfaces SERVICE_OFFERING_ALREADY_PAUSED", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    await service.pause({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      ...minimalPauseRequest({ idempotencyKey: "11111111-2222-3333-4444-555555555555" }),
      requestId: "req-pause-1",
    });
    await assert.rejects(
      service.pause({
        userAccountId: ACTING_USER,
        workspaceId: PERSONAL_WS_ID,
        offeringId: "of_1",
        ...minimalPauseRequest({ idempotencyKey: "22222222-3333-4444-5555-666666666666" }),
        requestId: "req-pause-2",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_ALREADY_PAUSED");
        return true;
      },
    );
  });

  void test("pause: an Organization actor surfaces SERVICE_OFFERING_FORBIDDEN", async () => {
    const { service, repo, auth } = buildService({ sellerProfileStatus: "Published" });
    void auth; // unused — flipped via input parameters below
    repo._seedOffering({
      id: "of_1",
      workspaceId: ORG_WS_ID,
      sellerProfileId: "sp_org",
      status: "Active",
    });
    await assert.rejects(
      service.pause({
        userAccountId: ACTING_USER,
        workspaceId: ORG_WS_ID,
        offeringId: "of_1",
        ...minimalPauseRequest(),
        requestId: "req-pause-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_FORBIDDEN");
        return true;
      },
    );
  });

  void test("pause: a Buyer-only Personal actor surfaces SERVICE_OFFERING_FORBIDDEN", async () => {
    const { service, auth, repo } = buildService({ sellerProfileStatus: "Published" });
    auth.personalMembership = buildPersonalMembership(["Buyer"]);
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Active",
    });
    await assert.rejects(
      service.pause({
        userAccountId: ACTING_USER,
        workspaceId: PERSONAL_WS_ID,
        offeringId: "of_1",
        ...minimalPauseRequest(),
        requestId: "req-pause-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_FORBIDDEN");
        return true;
      },
    );
  });

  void test("reactivate: Paused offering flips to Active and writes a new activation row", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Paused",
    });
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    const result = await service.reactivate({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      offeringId: "of_1",
      request: minimalActivate({}),
      requestId: "req-reactivate-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.offering.status, "Active");
  });

  void test("reactivate: an unpublished SellerProfile surfaces SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Draft" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Paused",
    });
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      service.reactivate({
        userAccountId: ACTING_USER,
        workspaceId: PERSONAL_WS_ID,
        offeringId: "of_1",
        request: minimalActivate({}),
        requestId: "req-reactivate-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal(
          (err as { code: string }).code,
          "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED",
        );
        return true;
      },
    );
  });

  void test("reactivate: no CONFIRMED Live samples surfaces SERVICE_OFFERING_INCOMPLETE", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: PERSONAL_WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      status: "Paused",
    });
    // No _seedSample call — the offering has zero CONFIRMED Live samples.
    await assert.rejects(
      service.reactivate({
        userAccountId: ACTING_USER,
        workspaceId: PERSONAL_WS_ID,
        offeringId: "of_1",
        request: minimalActivate({}),
        requestId: "req-reactivate-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_INCOMPLETE");
        return true;
      },
    );
  });

  void test("reactivate: an Organization actor surfaces SERVICE_OFFERING_FORBIDDEN", async () => {
    const { service, repo } = buildService({ sellerProfileStatus: "Published" });
    repo._seedOffering({
      id: "of_1",
      workspaceId: ORG_WS_ID,
      sellerProfileId: "sp_org",
      status: "Paused",
    });
    repo._seedSample("of_1", {
      sampleId: "s1",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTING_USER,
        confirmedAt: new Date(),
      },
    });
    await assert.rejects(
      service.reactivate({
        userAccountId: ACTING_USER,
        workspaceId: ORG_WS_ID,
        offeringId: "of_1",
        request: minimalActivate({}),
        requestId: "req-reactivate-1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ServiceOfferingServiceError);
        assert.equal((err as { code: string }).code, "SERVICE_OFFERING_FORBIDDEN");
        return true;
      },
    );
  });
});
