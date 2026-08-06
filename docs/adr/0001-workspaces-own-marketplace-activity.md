---
status: accepted
---

# Workspaces own marketplace activity

SoundHub separates a human `UserAccount` from the `Workspace` it acts for. Workspaces own
capabilities, SellerProfiles, ProjectRequests, Deals, and payment authorizations; humans act through
audited WorkspaceMemberships. This supports solo professionals, multiple brands, bands, studios,
and buyer organizations without shared credentials or false claims that platform membership proves
legal ownership. It supersedes `docs/architecture/adr-001-marketplace-identity.md`, whose direct
account-to-profile ownership cannot represent shared control.

## Consequences

- A Workspace may be personal or organizational, but its type does not grant Buyer or Seller
  capability.
- Creative organizations such as bands, studios, and collectives may sell; buyer categories acting
  as managers, executives, licensing houses, brands, or agencies remain buyer-only in the MVP.
- One Workspace owns at most one SellerProfile in the MVP; one UserAccount may belong to multiple
  Workspaces.
- One explicitly authorized DealApprover may approve terms for a Workspace. Every consequential
  action records both the Workspace party and human actor.
- Wallet control is verified independently and then authorized for Workspace funding or payout.
- SoundHub records declared authority but does not adjudicate group-name ownership, copyrights,
  internal revenue splits, or membership disputes.
