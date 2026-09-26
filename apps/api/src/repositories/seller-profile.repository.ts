// Repository abstraction for the M2 (#84) SellerProfile slice.
//
// Background: BG1-BG6 establish a strict layering rule — repositories
// own Prisma queries and FOR UPDATE-locked transaction boundaries;
// services own authorization policy and use-case composition; routes
// own HTTP concerns and safe error mapping. This module defines the
// application-layer surface for the SellerProfile slice.
//
// The repository is the only place that reads or writes `seller_profiles`,
// `seller_profile_specialties`, `caribbean_affiliations`, and
// `seller_profile_publications`. Other layers depend on this interface;
// the Prisma + in-memory adapters live next to it.
//
// Four domain-level operations are exposed. Each composes the
// per-Workspace serialization + read + validate + write + rollback
// internally, mirroring the `InMemoryAuthRepository.provisionIntentAtomically`
// pattern (apps/api/src/auth-repository/in-memory-auth-repository.ts:439):
//   - `saveDraft`: lazy first-save / resume / update-draft. Uses
//     `INSERT ... ON CONFLICT (workspaceId) DO NOTHING` to enforce
//     the at-most-one profile-per-Workspace invariant.
//   - `publishProfile`: atomic Draft -> Published transition with
//     immutable evidence row insertion.
//   - `updatePublishedProfile`: atomic full field set replacement
//     on a Published profile; rolls back on any FK violation.
//   - `findCurrentProfile`: read for the editor / review on-mount GET.
//
// Retry semantics: each publish / update command is bound to a
// client-supplied `idempotencyKey`. The DB unique constraint
// `(workspaceId, idempotencyKey)` on `seller_profile_publications` is
// the second defense against transport-retry duplicates (the first
// defense is the application-layer pre-transaction check in
// `SellerProfileService.publishProfile` / `updatePublishedProfile`).

import type {
  SellerProfileDisciplineV1,
  SellerProfileIdentityV1,
  SellerProfilePublicationConfirmationVersionV1,
} from "@soundhub/types";

export interface SellerProfileDraftInput {
  readonly workspaceId: string;
  readonly identity: SellerProfileIdentityV1;
  readonly basedIn: {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  };
  readonly disciplines: SellerProfileDisciplineV1;
  readonly now: Date;
}

export interface SellerProfilePublicationInput {
  readonly workspaceId: string;
  readonly identity: SellerProfileIdentityV1;
  readonly basedIn: {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  };
  readonly disciplines: SellerProfileDisciplineV1;
  readonly confirmationVersion: SellerProfilePublicationConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly publishedByUserId: string;
  readonly now: Date;
}

export interface SellerProfileOwnerViewRecord {
  readonly sellerProfileId: string;
  readonly workspaceId: string;
  readonly status: "Draft" | "Published" | "Suspended";
  readonly identity: SellerProfileIdentityV1;
  readonly basedIn: {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  };
  readonly disciplines: SellerProfileDisciplineV1;
  readonly publishedAt: Date | null;
  readonly publishedByUserId: string | null;
  readonly publishedByDisplayName: string | null;
}

export interface SellerProfilePublicationEvidenceView {
  readonly publishedAt: Date;
  readonly confirmationVersion: SellerProfilePublicationConfirmationVersionV1;
  readonly idempotencyKey: string;
}

export interface SellerProfilePublicationResult {
  readonly profile: SellerProfileOwnerViewRecord;
  readonly evidence: SellerProfilePublicationEvidenceView;
  /**
   * `true` when the operation converged on an already-persisted
   * publication (transport retry after a lost response). The
   * caller treats this as success; the UI does not need to
   * distinguish it from a fresh publish except for logging.
   */
  readonly convergedFromExistingPublication: boolean;
}

export class SellerProfileNotFoundError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`No SellerProfile found for workspace ${workspaceId}`);
    this.name = "SellerProfileNotFoundError";
  }
}

export class SellerProfileNotDraftError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly currentStatus: "Draft" | "Published" | "Suspended",
  ) {
    super(`SellerProfile for workspace ${workspaceId} is ${currentStatus}; Publish requires Draft`);
    this.name = "SellerProfileNotDraftError";
  }
}

export class SellerProfileNotPublishedError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`SellerProfile for workspace ${workspaceId} is Draft; Update requires Published`);
    this.name = "SellerProfileNotPublishedError";
  }
}

export interface SellerProfileRepository {
  /**
   * Save the draft — lazy first-save, resume, or update-draft.
   * Idempotent on `(workspaceId)` via the unique constraint. A
   * Published profile cannot be modified through this method
   * (the service rejects earlier with `SellerProfileNotDraftError`).
   */
  saveDraft(input: SellerProfileDraftInput): Promise<SellerProfileOwnerViewRecord>;

  /**
   * Atomic Draft -> Published transition + immutable evidence row
   * insertion. The idempotencyKey is bound to the (workspaceId,
   * idempotencyKey) DB unique constraint; a transport retry with
   * the same key converges on the already-persisted evidence.
   */
  publishProfile(input: SellerProfilePublicationInput): Promise<SellerProfilePublicationResult>;

  /**
   * Atomic full field set replacement on a Published profile.
   * Creates a new evidence row (a successful publish that mutates
   * the field set is a new publication event). A transport retry
   * with the same idempotencyKey converges on the already-persisted
   * evidence.
   */
  updatePublishedProfile(
    input: SellerProfilePublicationInput,
  ): Promise<SellerProfilePublicationResult>;

  /**
   * Read the current SellerProfile for the Workspace. Returns
   * `null` when no draft row exists yet.
   */
  findCurrentProfile(workspaceId: string): Promise<SellerProfileOwnerViewRecord | null>;
}
