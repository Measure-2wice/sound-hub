// Unit tests for SellerProfileService (M2 #84).
//
// Run via `pnpm --filter @soundhub/api test` (the api package's test
// script invokes this file explicitly). Coverage:
//   - Authorization: Personal-Workspace-only AND Seller-capable
//     precondition. Buyer-only Personal Workspace, Organization
//     Workspace, and signed-out actors all rejected.
//   - Lazy first-save: two Save Draft calls on the same fresh
//     Workspace converge on the same row.
//   - Resume: a Save Draft after the first save returns the existing
//     row with the persisted values.
//   - Publish: complete field set passes; incomplete payload
//     (specialtyKeys empty OR caribbeanAffiliationCodes empty)
//     returns SELLER_PROFILE_INCOMPLETE.
//   - Second Publish on a Published profile returns
//     SELLER_PROFILE_NOT_DRAFT.
//   - Update on a Draft profile returns SELLER_PROFILE_NOT_PUBLISHED.
//   - Retry convergence: same `idempotencyKey` returns the existing
//     evidence row without creating a second row.
//   - New attempt with a different `idempotencyKey` creates a new
//     evidence row.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import {
  AuthorizationError,
  PersonalActingMembershipError,
  type ActingMembership,
} from "./workspace-authorization.service.js";
import { InMemorySellerProfileRepository } from "../repositories/in-memory-seller-profile.repository.js";
import { SellerProfileService, SellerProfileServiceError } from "./seller-profile.service.js";
import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  SellerProfileDraftRequestV1,
  SellerProfilePublishRequestV1,
  SellerProfileUpdateRequestV1,
} from "@soundhub/types";

const ACTING_USER = "user_acting_1";
const PERSONAL_WS_ID = "ws_personal_1";
const ORG_WS_ID = "ws_org_1";

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
  // The "acting-Workspace" shape the stub returns for a Personal
  // request. The service calls `requirePersonalActingMembership`
  // which gates on the Workspace type, NOT on the workspaceId.
  personalMembership: ActingMembership = buildPersonalMembership();
  orgMembership: ActingMembership = buildOrgMembership();

  requirePersonalActingMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<ActingMembership> {
    // Mirror the real WorkspaceAuthorizationService: a request for
    // a Workspace whose type is not Personal fails this check,
    // regardless of whether the actor is a current member.
    if (
      this.personalMembership.workspace.workspaceType !== "Personal" ||
      input.workspaceId === ORG_WS_ID
    ) {
      throw new PersonalActingMembershipError(
        "Organization Workspace is out of #84 scope; Personal-Workspace-only",
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

function buildService(): {
  service: SellerProfileService;
  repo: InMemorySellerProfileRepository;
  auth: StubWorkspaceAuthorizationService;
} {
  const repo = new InMemorySellerProfileRepository();
  const auth = new StubWorkspaceAuthorizationService();
  const service = new SellerProfileService({
    repository: repo,
    workspaceAuthorizationService: auth as unknown as WorkspaceAuthorizationService,
  });
  return { service, repo, auth };
}

const draftPayload: SellerProfileDraftRequestV1 = {
  identity: {
    professionalName: "Creole Beats Brooklyn",
    bio: "Brooklyn-based production studio.",
  },
  basedIn: { countryCode: "US", region: "New York", city: "Brooklyn" },
  disciplines: {
    specialtyKeys: ["Producer", "SoundEngineer"],
    caribbeanAffiliationCodes: ["HT"],
  },
};

// Strict variant of `draftPayload` for publish/update paths. The
// draft schema allows `countryCode` to be omitted; the
// publish/update schema does not. Tests that exercise
// publish/update re-assert the country so the strict type is
// satisfied and any drift between the two schemas surfaces at
// compile time.
const strictBasedIn: { countryCode: string; region?: string; city?: string } = {
  countryCode: draftPayload.basedIn.countryCode ?? "US",
  region: draftPayload.basedIn.region,
  city: draftPayload.basedIn.city,
};

const publishPayload: SellerProfilePublishRequestV1 = {
  identity: draftPayload.identity,
  basedIn: strictBasedIn,
  disciplines: draftPayload.disciplines,
  confirmationVersion: "m2-profile-publication-v1",
  idempotencyKey: "11111111-2222-3333-4444-555555555555",
};

void describe("SellerProfileService.saveDraft", () => {
  void test("lazy first save creates a Draft row and persists the values", async () => {
    const { service } = buildService();
    const result = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    assert.equal(result.profile.status, "Draft");
    assert.equal(result.profile.identity.professionalName, "Creole Beats Brooklyn");
    assert.deepEqual(result.profile.disciplines.specialtyKeys, ["Producer", "SoundEngineer"]);
    assert.deepEqual(result.profile.disciplines.caribbeanAffiliationCodes, ["HT"]);
  });

  void test("partial draft with empty professional name + bio is allowed (resume on later save)", async () => {
    // Per M2 #84 acceptance criteria: "Incomplete pre-publication
    // Drafts remain private, resumable, absent from public DTOs,
    // and presented as Private draft." The first-save payload may
    // omit the publication-required identity values.
    const { service, repo } = buildService();
    const partial: SellerProfileDraftRequestV1 = {
      identity: { professionalName: "", bio: "" },
      basedIn: { countryCode: "US" },
      disciplines: { specialtyKeys: [], caribbeanAffiliationCodes: [] },
    };
    const result = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: partial,
    });
    assert.equal(result.profile.status, "Draft");
    assert.equal(result.profile.identity.professionalName, "");
    assert.equal(result.profile.identity.bio, "");
    assert.deepEqual(result.profile.disciplines.specialtyKeys, []);
    assert.deepEqual(result.profile.disciplines.caribbeanAffiliationCodes, []);
    // The Draft row exists and is private — the public owner view
    // for the same Workspace carries the partial state.
    const stored = repo._peekProfile(PERSONAL_WS_ID);
    assert.ok(stored);
    assert.equal(stored.status, "Draft");
  });

  void test("a partial draft can be resumed: subsequent save fills the missing fields", async () => {
    const { service } = buildService();
    const partial: SellerProfileDraftRequestV1 = {
      identity: { professionalName: "", bio: "" },
      basedIn: { countryCode: "US" },
      disciplines: { specialtyKeys: [], caribbeanAffiliationCodes: [] },
    };
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: partial,
    });
    const resumed = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    assert.equal(resumed.profile.identity.professionalName, "Creole Beats Brooklyn");
    assert.equal(resumed.profile.identity.bio, "Brooklyn-based production studio.");
    assert.deepEqual(resumed.profile.disciplines.specialtyKeys, ["Producer", "SoundEngineer"]);
  });

  void test("partial draft with no countryCode is allowed (resume on later save)", async () => {
    // Per M2 #84 acceptance: the editor must not silently
    // fabricate a country the seller never selected. A first-save
    // payload may omit basedIn.countryCode entirely; the row
    // stores NULL; publish/update completeness still require a
    // country at the trusted Zod boundary.
    const { service, repo } = buildService();
    const partial: SellerProfileDraftRequestV1 = {
      identity: { professionalName: "", bio: "" },
      basedIn: {},
      disciplines: { specialtyKeys: [], caribbeanAffiliationCodes: [] },
    };
    const result = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: partial,
    });
    assert.equal(result.profile.status, "Draft");
    assert.equal(result.profile.basedIn.countryCode, undefined);
    const stored = repo._peekProfile(PERSONAL_WS_ID);
    assert.ok(stored);
    assert.equal(stored.basedInCountryCode, null);
  });

  void test("unsupported Caribbean affiliation code is rejected at draft save with SELLER_PROFILE_INVALID + field errors", async () => {
    // Per M2 #84: Caribbean connection is a closed self-declared
    // surface. A direct API client must NOT be able to persist
    // `US` or `ZZ` as an affiliation. Validate at the trusted
    // service boundary, even on the draft save path.
    const { service } = buildService();
    const smuggled: SellerProfileDraftRequestV1 = {
      ...draftPayload,
      disciplines: {
        ...draftPayload.disciplines,
        caribbeanAffiliationCodes: ["HT", "US", "ZZ"],
      },
    };
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: smuggled,
        }),
      (err: unknown) => {
        if (!(err instanceof SellerProfileServiceError)) return false;
        if (err.code !== "SELLER_PROFILE_INVALID") return false;
        // One field error per offending code so the editor can
        // highlight each invalid chip.
        const paths = err.fieldErrors.map((f) => f.path);
        assert.deepEqual(paths, [
          "disciplines.caribbeanAffiliationCodes",
          "disciplines.caribbeanAffiliationCodes",
        ]);
        return true;
      },
    );
  });

  void test("a second save converges on the same row (no duplicate insert)", async () => {
    const { service, repo } = buildService();
    const first = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const beforeCount = repo._peekProfile(PERSONAL_WS_ID) === null ? 0 : 1;
    assert.equal(beforeCount, 1);
    const second = await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: {
        ...draftPayload,
        identity: { ...draftPayload.identity, bio: "Updated bio." },
      },
    });
    assert.equal(second.profile.sellerProfileId, first.profile.sellerProfileId);
    assert.equal(second.profile.identity.bio, "Updated bio.");
    assert.equal(repo._peekProfile(PERSONAL_WS_ID)?.id, first.profile.sellerProfileId);
  });

  void test("Organization Workspace actor is rejected with SELLER_PROFILE_FORBIDDEN", async () => {
    const { service, auth } = buildService();
    // The Personal-only authorization throws when the requested
    // workspaceId is the Organization Workspace (type check fails).
    auth.personalMembership = buildPersonalMembership();
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: ORG_WS_ID,
          request: draftPayload,
        }),
      (err: unknown) => {
        return err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_FORBIDDEN";
      },
    );
  });

  void test("Buyer-only Personal Workspace is rejected with SELLER_PROFILE_FORBIDDEN", async () => {
    const { service, auth } = buildService();
    auth.personalMembership = buildPersonalMembership(["Buyer"]);
    await assert.rejects(
      () =>
        service.saveDraft({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: draftPayload,
        }),
      (err: unknown) => {
        return err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_FORBIDDEN";
      },
    );
  });
});

void describe("SellerProfileService.publishProfile", () => {
  void test("first publish transitions Draft to Published and inserts the evidence row", async () => {
    const { service, repo } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const result = await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_publish_1",
    });
    assert.equal(result.profile.status, "Published");
    assert.ok(result.profile.publishedAt, "publishedAt should be set on the response");
    assert.equal(result.evidence.confirmationVersion, "m2-profile-publication-v1");
    assert.equal(result.evidence.idempotencyKey, publishPayload.idempotencyKey);
    const profile = repo._peekProfile(PERSONAL_WS_ID);
    assert.ok(profile);
    assert.equal(profile.status, "Published");
    assert.equal(
      repo._peekPublication(PERSONAL_WS_ID, publishPayload.idempotencyKey)?.publishedAt.getTime(),
      profile.publishedAt?.getTime(),
    );
  });

  void test("a second publish with the same idempotencyKey converges on the existing evidence row", async () => {
    const { service, repo } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const first = await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_publish_2",
    });
    const before = repo._peekProfile(PERSONAL_WS_ID);
    assert.ok(before);

    const second = await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_publish_2_retry",
    });
    // The response's evidence.publishedAt is an ISO string (per the
    // shared Zod response schema). Retry convergence means the
    // second call returns the SAME timestamp as the first.
    assert.equal(
      second.evidence.publishedAt,
      first.evidence.publishedAt,
      "converged publish returns the existing evidence timestamp",
    );
    const after = repo._peekProfile(PERSONAL_WS_ID);
    assert.equal(after?.publishedAt?.getTime(), before.publishedAt?.getTime());
  });

  void test("a second publish with a NEW idempotencyKey is rejected with SELLER_PROFILE_NOT_DRAFT", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_a",
    });
    const newKeyPayload = {
      ...publishPayload,
      idempotencyKey: "99999999-8888-7777-6666-555555555555",
    };
    await assert.rejects(
      () =>
        service.publishProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: newKeyPayload,
          requestId: "req_b",
        }),
      (err: unknown) => {
        return err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_NOT_DRAFT";
      },
    );
  });

  void test("incomplete payload (no Caribbean affiliation) returns SELLER_PROFILE_INCOMPLETE", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const incomplete: SellerProfilePublishRequestV1 = {
      ...publishPayload,
      disciplines: { ...publishPayload.disciplines, caribbeanAffiliationCodes: [] },
    };
    await assert.rejects(
      () =>
        service.publishProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: incomplete,
          requestId: "req_incomplete_1",
        }),
      (err: unknown) => {
        return err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_INCOMPLETE";
      },
    );
  });

  void test("incomplete payload (no controlled Specialty) returns SELLER_PROFILE_INCOMPLETE", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const incomplete: SellerProfilePublishRequestV1 = {
      ...publishPayload,
      disciplines: { ...publishPayload.disciplines, specialtyKeys: [] },
    };
    await assert.rejects(
      () =>
        service.publishProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: incomplete,
          requestId: "req_incomplete_2",
        }),
      (err: unknown) => {
        return err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_INCOMPLETE";
      },
    );
  });

  void test("publish with both specialties and Caribbean missing returns SELLER_PROFILE_INCOMPLETE with BOTH field errors", async () => {
    // The review recovery flow renders a focusable linked error
    // summary; it must list every missing-discipline field in one
    // response so the user sees the full picture without submitting
    // a corrected partial payload just to discover the next gap.
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const incomplete: SellerProfilePublishRequestV1 = {
      ...publishPayload,
      disciplines: {
        specialtyKeys: [],
        caribbeanAffiliationCodes: [],
      },
    };
    await assert.rejects(
      () =>
        service.publishProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: incomplete,
          requestId: "req_incomplete_both",
        }),
      (err: unknown) => {
        if (!(err instanceof SellerProfileServiceError)) return false;
        if (err.code !== "SELLER_PROFILE_INCOMPLETE") return false;
        const paths = err.fieldErrors.map((f) => f.path);
        assert.deepEqual(paths, [
          "disciplines.specialtyKeys",
          "disciplines.caribbeanAffiliationCodes",
        ]);
        return true;
      },
    );
  });

  void test("publish with unsupported Caribbean affiliation returns SELLER_PROFILE_INVALID with field errors", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const smuggled: SellerProfilePublishRequestV1 = {
      ...publishPayload,
      disciplines: {
        ...publishPayload.disciplines,
        caribbeanAffiliationCodes: ["ZZ"],
      },
    };
    await assert.rejects(
      () =>
        service.publishProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: smuggled,
          requestId: "req_publish_smuggled",
        }),
      (err: unknown) => {
        if (!(err instanceof SellerProfileServiceError)) return false;
        if (err.code !== "SELLER_PROFILE_INVALID") return false;
        assert.equal(err.fieldErrors.length, 1);
        assert.equal(err.fieldErrors[0]?.path, "disciplines.caribbeanAffiliationCodes");
        return true;
      },
    );
  });
});

void describe("SellerProfileService.updatePublishedProfile", () => {
  void test("post-publication update replaces the field set and inserts a new evidence row", async () => {
    const { service, repo } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_pub",
    });
    const updatePayload: SellerProfileUpdateRequestV1 = {
      identity: {
        professionalName: "Creole Beats Brooklyn — Updated",
        bio: "Updated bio post-publication.",
      },
      basedIn: strictBasedIn,
      disciplines: draftPayload.disciplines,
      confirmationVersion: "m2-profile-publication-v1",
      idempotencyKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    const result = await service.updatePublishedProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: updatePayload,
      requestId: "req_update",
    });
    assert.equal(result.profile.identity.professionalName, "Creole Beats Brooklyn — Updated");
    assert.equal(result.profile.status, "Published");
    assert.ok(repo._peekPublication(PERSONAL_WS_ID, updatePayload.idempotencyKey));
  });

  void test("update on a Draft profile is rejected with SELLER_PROFILE_NOT_PUBLISHED", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    await assert.rejects(
      () =>
        service.updatePublishedProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: {
            identity: draftPayload.identity,
            basedIn: strictBasedIn,
            disciplines: draftPayload.disciplines,
            confirmationVersion: "m2-profile-publication-v1",
            idempotencyKey: "ddddddd-eeee-ffff-0000-111111111111",
          },
          requestId: "req_update_draft",
        }),
      (err: unknown) => {
        return (
          err instanceof SellerProfileServiceError && err.code === "SELLER_PROFILE_NOT_PUBLISHED"
        );
      },
    );
  });

  void test("update with unsupported Caribbean affiliation returns SELLER_PROFILE_INVALID with field errors", async () => {
    // Caribbean affiliation validation must apply on the UPDATE
    // path too — a Published profile cannot be re-published with a
    // smuggled affiliation code.
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_pub_for_update_smuggle",
    });
    const smuggled: SellerProfileUpdateRequestV1 = {
      identity: draftPayload.identity,
      basedIn: strictBasedIn,
      disciplines: {
        ...draftPayload.disciplines,
        caribbeanAffiliationCodes: ["ZZ"],
      },
      confirmationVersion: "m2-profile-publication-v1",
      idempotencyKey: "eeeeeee-ffff-0000-1111-222222222222",
    };
    await assert.rejects(
      () =>
        service.updatePublishedProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: smuggled,
          requestId: "req_update_smuggle",
        }),
      (err: unknown) => {
        if (!(err instanceof SellerProfileServiceError)) return false;
        if (err.code !== "SELLER_PROFILE_INVALID") return false;
        assert.equal(err.fieldErrors[0]?.path, "disciplines.caribbeanAffiliationCodes");
        return true;
      },
    );
  });

  void test("update with both disciplines missing returns SELLER_PROFILE_INCOMPLETE with BOTH field errors", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    await service.publishProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: publishPayload,
      requestId: "req_pub_for_update_both",
    });
    const incomplete: SellerProfileUpdateRequestV1 = {
      identity: draftPayload.identity,
      basedIn: strictBasedIn,
      disciplines: {
        specialtyKeys: [],
        caribbeanAffiliationCodes: [],
      },
      confirmationVersion: "m2-profile-publication-v1",
      idempotencyKey: "ffffff-0000-1111-2222-333333333333",
    };
    await assert.rejects(
      () =>
        service.updatePublishedProfile({
          userAccountId: ACTING_USER,
          workspaceId: PERSONAL_WS_ID,
          request: incomplete,
          requestId: "req_update_both",
        }),
      (err: unknown) => {
        if (!(err instanceof SellerProfileServiceError)) return false;
        if (err.code !== "SELLER_PROFILE_INCOMPLETE") return false;
        const paths = err.fieldErrors.map((f) => f.path);
        assert.deepEqual(paths, [
          "disciplines.specialtyKeys",
          "disciplines.caribbeanAffiliationCodes",
        ]);
        return true;
      },
    );
  });
});

void describe("SellerProfileService.getCurrentProfile", () => {
  void test("returns null when no draft row exists yet", async () => {
    const { service } = buildService();
    const result = await service.getCurrentProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
    });
    assert.equal(result.profile, null);
  });

  void test("returns the persisted Draft on subsequent calls", async () => {
    const { service } = buildService();
    await service.saveDraft({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
      request: draftPayload,
    });
    const result = await service.getCurrentProfile({
      userAccountId: ACTING_USER,
      workspaceId: PERSONAL_WS_ID,
    });
    assert.ok(result.profile);
    assert.equal(result.profile.status, "Draft");
  });
});

// Suppress unused-imports lint when the file is selectively consumed.
void ({} as { readonly _unused: Bg1IdentityProviderV1 });
