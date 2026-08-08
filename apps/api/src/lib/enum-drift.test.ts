// Drift test: the closed behavior states must be identical between the
// Prisma enums (the persistence layer) and the Zod schemas (the public
// contract). If either side adds or renames a value, this test fails fast
// at module load and at test time, forcing an explicit decision before any
// search query can run.

/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MarketplaceCapability,
  PricingKind,
  PurchaseMode,
  SellerProfileStatus,
  ServiceMode,
  ServiceOfferingStatus,
  WorkspaceMembershipRole,
  WorkspaceStatus,
  WorkspaceType,
} from "@soundhub/db";
import {
  marketplaceCapabilityValuesV1,
  pricingKindValuesV1,
  purchaseModeValuesV1,
  sellerProfileStatusValuesV1,
  serviceModeValuesV1,
  serviceOfferingStatusValuesV1,
  workspaceMembershipRoleValuesV1,
  workspaceStatusValuesV1,
  workspaceTypeValuesV1,
} from "@soundhub/types";

const sortStrings = (values: readonly string[]): string[] => [...values].sort();

describe("closed enum drift", () => {
  test("WorkspaceType values match the Zod surface", () => {
    assert.deepEqual(sortStrings(Object.values(WorkspaceType)), sortStrings(workspaceTypeValuesV1));
  });
  test("WorkspaceStatus values match the Zod surface", () => {
    assert.deepEqual(
      sortStrings(Object.values(WorkspaceStatus)),
      sortStrings(workspaceStatusValuesV1),
    );
  });
  test("WorkspaceMembershipRole values match the Zod surface", () => {
    assert.deepEqual(
      sortStrings(Object.values(WorkspaceMembershipRole)),
      sortStrings(workspaceMembershipRoleValuesV1),
    );
  });
  test("MarketplaceCapability values match the Zod surface", () => {
    assert.deepEqual(
      sortStrings(Object.values(MarketplaceCapability)),
      sortStrings(marketplaceCapabilityValuesV1),
    );
  });
  test("SellerProfileStatus values match the Zod surface", () => {
    assert.deepEqual(
      sortStrings(Object.values(SellerProfileStatus)),
      sortStrings(sellerProfileStatusValuesV1),
    );
  });
  test("ServiceOfferingStatus values match the Zod surface", () => {
    assert.deepEqual(
      sortStrings(Object.values(ServiceOfferingStatus)),
      sortStrings(serviceOfferingStatusValuesV1),
    );
  });
  test("ServiceMode values match the Zod surface", () => {
    assert.deepEqual(sortStrings(Object.values(ServiceMode)), sortStrings(serviceModeValuesV1));
  });
  test("PricingKind values match the Zod surface", () => {
    assert.deepEqual(sortStrings(Object.values(PricingKind)), sortStrings(pricingKindValuesV1));
  });
  test("PurchaseMode values match the Zod surface", () => {
    assert.deepEqual(sortStrings(Object.values(PurchaseMode)), sortStrings(purchaseModeValuesV1));
  });
});
