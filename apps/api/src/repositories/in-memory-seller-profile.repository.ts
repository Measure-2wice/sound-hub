// In-memory implementation of SellerProfileRepository.
//
// Used by the API unit tests (apps/api/src/routes/seller-profile.test.ts,
// apps/api/src/services/seller-profile.service.test.ts,
// apps/api/src/services/seller-profile.service.personal-boundary.test.ts).
//
// Mirrors the Prisma adapter's atomic-write contract with a
// per-Workspace async mutex chain (Map<workspaceId, Promise<void>>)
// instead of FOR UPDATE locks. The mutex serializes all four
// operations per-Workspace so concurrent attempts observe the same
// sequencing the Prisma transaction-scoped locks would enforce.
//
// The (workspaceId, idempotencyKey) retry convergence is implemented
// at the application layer (mirroring the Prisma DB unique
// constraint): the publish / update methods look up the existing
// publication by (workspaceId, idempotencyKey) BEFORE writing; if
// found, they return the existing evidence without creating a new
// row.

import type {
  SellerProfileDisciplineV1,
  SellerProfileIdentityV1,
  SellerProfilePublicationConfirmationVersionV1,
} from "@soundhub/types";
import type {
  SellerProfileDraftInput,
  SellerProfileOwnerViewRecord,
  SellerProfilePublicationEvidenceView,
  SellerProfilePublicationInput,
  SellerProfilePublicationResult,
  SellerProfileRepository,
} from "./seller-profile.repository.js";
import {
  SellerProfileNotDraftError,
  SellerProfileNotPublishedError,
} from "./seller-profile.repository.js";

interface StoredProfile {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: "Draft" | "Published" | "Suspended";
  readonly identity: SellerProfileIdentityV1;
  readonly basedInCountryCode: string;
  readonly basedInRegion: string | null;
  readonly basedInCity: string | null;
  readonly specialtyKeys: readonly string[];
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly publishedAt: Date | null;
  readonly publishedByUserId: string | null;
  readonly publishedByDisplayName: string | null;
}

interface StoredPublication {
  readonly id: string;
  readonly publishedByUserId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly confirmationVersion: SellerProfilePublicationConfirmationVersionV1;
  readonly publishedAt: Date;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

let nextId = 1;
function generateCuid(): string {
  nextId += 1;
  return `sp_mem_${nextId.toString(36)}`;
}

export class InMemorySellerProfileRepository implements SellerProfileRepository {
  private readonly profilesByWorkspace = new Map<string, StoredProfile>();
  private readonly publicationsByWorkspaceIdem = new Map<string, StoredPublication>();
  // Per-Workspace mutex chain. Each new operation appends to the
  // chain; awaits resolve in FIFO order.
  private readonly mutexChains = new Map<string, Promise<void>>();

  private async withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutexChains.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexChains.set(
      workspaceId,
      previous.then(() => next),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private idemKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}::${idempotencyKey}`;
  }

  private toOwnerView(profile: StoredProfile): SellerProfileOwnerViewRecord {
    const basedIn: { countryCode: string; region?: string; city?: string } = {
      countryCode: profile.basedInCountryCode,
    };
    if (profile.basedInRegion !== null) basedIn.region = profile.basedInRegion;
    if (profile.basedInCity !== null) basedIn.city = profile.basedInCity;
    const disciplines: SellerProfileDisciplineV1 = {
      specialtyKeys: [...profile.specialtyKeys],
      caribbeanAffiliationCodes: [...profile.caribbeanAffiliationCodes],
    };
    return {
      sellerProfileId: profile.id,
      workspaceId: profile.workspaceId,
      status: profile.status,
      identity: { ...profile.identity },
      basedIn,
      disciplines,
      publishedAt: profile.publishedAt,
      publishedByUserId: profile.publishedByUserId,
      publishedByDisplayName: profile.publishedByDisplayName,
    };
  }

  private toEvidenceView(p: StoredPublication): SellerProfilePublicationEvidenceView {
    return {
      publishedAt: p.publishedAt,
      confirmationVersion: p.confirmationVersion,
      idempotencyKey: p.idempotencyKey,
    };
  }

  async findCurrentProfile(workspaceId: string): Promise<SellerProfileOwnerViewRecord | null> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const existing = this.profilesByWorkspace.get(workspaceId) ?? null;
      return existing ? this.toOwnerView(existing) : null;
    });
  }

  async saveDraft(input: SellerProfileDraftInput): Promise<SellerProfileOwnerViewRecord> {
    return this.withWorkspaceLock(input.workspaceId, async () => {
      const existing = this.profilesByWorkspace.get(input.workspaceId);
      if (existing) {
        if (existing.status === "Published" || existing.status === "Suspended") {
          throw new SellerProfileNotDraftError(input.workspaceId, existing.status);
        }
        const updated: StoredProfile = {
          ...existing,
          identity: this.normalizedIdentity(input.identity, existing.identity.avatarUrl ?? null),
          basedInCountryCode: input.basedIn.countryCode,
          basedInRegion: input.basedIn.region ?? null,
          basedInCity: input.basedIn.city ?? null,
          specialtyKeys: [...input.disciplines.specialtyKeys],
          caribbeanAffiliationCodes: [...input.disciplines.caribbeanAffiliationCodes],
        };
        this.profilesByWorkspace.set(input.workspaceId, updated);
        return this.toOwnerView(updated);
      }
      const created: StoredProfile = {
        id: generateCuid(),
        workspaceId: input.workspaceId,
        status: "Draft",
        identity: this.normalizedIdentity(input.identity, input.identity.avatarUrl ?? null),
        basedInCountryCode: input.basedIn.countryCode,
        basedInRegion: input.basedIn.region ?? null,
        basedInCity: input.basedIn.city ?? null,
        specialtyKeys: [...input.disciplines.specialtyKeys],
        caribbeanAffiliationCodes: [...input.disciplines.caribbeanAffiliationCodes],
        publishedAt: null,
        publishedByUserId: null,
        publishedByDisplayName: null,
      };
      this.profilesByWorkspace.set(input.workspaceId, created);
      return this.toOwnerView(created);
    });
  }

  // The Publication input requires an actingUserId + actingUserDisplayName
  // for evidence attribution. Override the interface signature via a
  // type-narrowed helper that the test fixtures pass through.
  // ... The repository's own `publishProfile` / `updatePublishedProfile`
  // use a synthetic actingUser when not provided (the service layer
  // injects the real actor via `SellerProfileService.publishProfile`,
  // which reads the userAccountId from the session and falls back to
  // a synthetic display name when the UserAccount has none).

  async publishProfile(
    input: SellerProfilePublicationInput,
  ): Promise<SellerProfilePublicationResult> {
    return this.writePublication(input, /* requireDraft */ true);
  }

  async updatePublishedProfile(
    input: SellerProfilePublicationInput,
  ): Promise<SellerProfilePublicationResult> {
    return this.writePublication(input, /* requireDraft */ false);
  }

  private async writePublication(
    input: SellerProfilePublicationInput,
    requireDraft: boolean,
  ): Promise<SellerProfilePublicationResult> {
    return this.withWorkspaceLock(input.workspaceId, async () => {
      // Step 1: idempotency check. A transport retry with the
      // same key converges on the already-persisted evidence.
      const idemKey = this.idemKey(input.workspaceId, input.idempotencyKey);
      const existingPublication = this.publicationsByWorkspaceIdem.get(idemKey);
      if (existingPublication) {
        const existing = this.profilesByWorkspace.get(input.workspaceId);
        if (!existing) {
          throw new Error(
            `InMemorySellerProfileRepository.writePublication: existing publication without profile for workspace=${input.workspaceId}`,
          );
        }
        return {
          profile: this.toOwnerView(existing),
          evidence: this.toEvidenceView(existingPublication),
          convergedFromExistingPublication: true,
        };
      }

      // Step 2: precondition check.
      const existing = this.profilesByWorkspace.get(input.workspaceId);
      if (!existing) {
        throw new Error(
          `InMemorySellerProfileRepository.writePublication: no draft row for workspace=${input.workspaceId}`,
        );
      }
      if (requireDraft && existing.status !== "Draft") {
        throw new SellerProfileNotDraftError(input.workspaceId, existing.status);
      }
      if (!requireDraft && existing.status !== "Published") {
        throw new SellerProfileNotPublishedError(input.workspaceId);
      }

      // Step 3: snapshot for rollback on any failure mid-write.
      const before: StoredProfile = {
        ...existing,
        identity: { ...existing.identity },
        specialtyKeys: [...existing.specialtyKeys],
        caribbeanAffiliationCodes: [...existing.caribbeanAffiliationCodes],
      };

      try {
        const updated: StoredProfile = {
          ...existing,
          status: "Published",
          identity: this.normalizedIdentity(input.identity, existing.identity.avatarUrl ?? null),
          basedInCountryCode: input.basedIn.countryCode,
          basedInRegion: input.basedIn.region ?? null,
          basedInCity: input.basedIn.city ?? null,
          specialtyKeys: [...input.disciplines.specialtyKeys],
          caribbeanAffiliationCodes: [...input.disciplines.caribbeanAffiliationCodes],
          publishedAt: input.now,
          publishedByUserId: input.publishedByUserId,
          publishedByDisplayName: existing.publishedByDisplayName ?? input.publishedByUserId,
        };
        const publication: StoredPublication = {
          id: generateCuid(),
          publishedByUserId: input.publishedByUserId,
          workspaceId: input.workspaceId,
          sellerProfileId: existing.id,
          confirmationVersion: input.confirmationVersion,
          publishedAt: input.now,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        };
        this.profilesByWorkspace.set(input.workspaceId, updated);
        this.publicationsByWorkspaceIdem.set(idemKey, publication);
        return {
          profile: this.toOwnerView(updated),
          evidence: this.toEvidenceView(publication),
          convergedFromExistingPublication: false,
        };
      } catch (err) {
        // Rollback to the snapshot so a mid-write failure cannot
        // leave the profile in a half-published state.
        this.profilesByWorkspace.set(input.workspaceId, before);
        throw err;
      }
    });
  }

  private normalizedIdentity(
    input: SellerProfileIdentityV1,
    fallbackAvatarUrl: string | null,
  ): SellerProfileIdentityV1 {
    const avatarUrl = input.avatarUrl ?? fallbackAvatarUrl;
    if (avatarUrl === null) {
      return {
        professionalName: input.professionalName,
        bio: input.bio,
      };
    }
    return {
      professionalName: input.professionalName,
      bio: input.bio,
      avatarUrl,
    };
  }

  // Test-only inspection helpers. NOT part of the repository
  // interface; tests use these to assert persistence behavior.
  _peekProfile(workspaceId: string): StoredProfile | null {
    return this.profilesByWorkspace.get(workspaceId) ?? null;
  }
  _peekPublication(workspaceId: string, idempotencyKey: string): StoredPublication | null {
    return this.publicationsByWorkspaceIdem.get(this.idemKey(workspaceId, idempotencyKey)) ?? null;
  }
}
