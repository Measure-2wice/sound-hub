# ADR-001: Marketplace Identity and Capabilities

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SoundHub product and engineering
- **Related:** [`spec.md`](../../spec.md), [Milestone 1 plan](../plans/milestone-1-talent-search.md)

## Context

SoundHub began with a single `Artist | Producer` role, but the intended marketplace is broader:

- Artists, producers, musicians, songwriters, and sound engineers may buy and sell services.
- Managers, executives, licensing houses, brands, agencies, and sync buyers purchase talent.
- The marketplace may later include videographers, editors, influencers, and other content
  creatives.
- A wallet proves authority over blockchain transactions; it is not a complete application
  identity or account-recovery mechanism.

A single role enum would conflate identity, occupation, discoverability, and authorization. It
would also make dual-sided accounts and future creative categories difficult to represent.

## Decision

### Account identity

Every user has one SoundHub account authenticated off-chain. The initial authentication mechanism
will be an email magic link or passkey. Authentication implementation is outside Milestone 1.

An account has one account type:

```ts
type AccountType = "Individual" | "Organization";
```

Organization membership and multiple seats are deferred. An organization is represented by one
account during the MVP.

### Marketplace capabilities

Buying and selling are independent capabilities:

```ts
type MarketplaceCapability = "Buyer" | "Seller";
```

- Creative individuals may hold both capabilities.
- Managers, executives, licensing houses, brands, agencies, and sync buyers are buyer-only in the
  MVP.
- Capability checks are enforced by application services and route authorization, not only by UI
  visibility or database enums.
- A user without the `Seller` capability cannot publish a seller profile or accept seller-side
  deal actions.

### Seller profile

Sell-side marketplace data belongs to `SellerProfile`, not `User` and not a category-specific
`ArtistProfile` or `ProducerProfile`.

```ts
type SellerSpecialty =
  | "Artist"
  | "Producer"
  | "Musician"
  | "Songwriter"
  | "SoundEngineer"
  | "Videographer"
  | "VideoEditor"
  | "Influencer";
```

Milestone 1 seeds music-focused specialties. The later content-creative specialties remain valid
domain values but do not require dedicated product flows yet.

`SellerProfile` owns public discovery data such as:

- Display biography
- Specialties
- Genres
- Country or region
- Public rate information
- Portfolio and tracks
- Search-index metadata

Private account data such as email addresses, wallet challenges, authentication identifiers, and
internal embeddings must not be exposed through public talent APIs.

### Wallet identity

Wallets are separate verified associations:

```ts
interface WalletAssociation {
  userId: string;
  network: string;
  address: string;
  verifiedAt: string | null;
}
```

- Linking a wallet requires signing a server-issued nonce.
- A seller may publish a profile without a wallet but must verify a payout wallet before approving
  an escrow-backed deal.
- A buyer must verify a wallet before funding escrow.
- Financial actions require explicit wallet confirmation even when the SoundHub web session is
  authenticated.
- Wallet implementation is outside Milestone 1.

## Authorization invariants

1. Occupation and specialty never grant authorization by themselves.
2. `Buyer` and `Seller` capabilities are evaluated server-side.
3. Public APIs return seller-profile data, not unrestricted user records.
4. Removing a capability does not erase historical deals or audit records.
5. Wallet ownership does not automatically grant access to an unrelated SoundHub account.
6. Changing a payout wallet must not modify historical payment records.

## Consequences

### Positive

- A creative can participate on both sides of the marketplace.
- Future creative categories fit the same profile and authorization model.
- Public discovery data has a clear privacy boundary.
- Account recovery and organization identity do not depend on wallet custody.
- Blockchain authorization can evolve independently from application authentication.

### Costs

- Authorization requires capability checks instead of one role comparison.
- Existing `Role`, `ProducerProfile`, and producer-oriented shared types must be migrated.
- Buyer-only policy is business logic and requires tests.
- Organization membership will require a later model rather than overloading `User`.

## Rejected alternatives

### One role per user

Rejected because a creative may be both buyer and seller.

### Separate account for every marketplace role

Rejected because it fragments identity, messages, deals, and reputation.

### Wallet-only authentication

Rejected because account recovery, email notifications, organization membership, and nonfinancial
product actions need a stable off-chain identity.

### Category-specific profile tables

Rejected for the MVP because `ArtistProfile`, `ProducerProfile`, and future profession-specific
tables would duplicate common discovery and marketplace fields.

## Follow-up decisions

- Choose email magic link or passkey authentication.
- Define organization membership and delegated authority.
- Define the exact wallet networks and account-address formats.
- Decide whether specialties remain an enum or become managed taxonomy records after the MVP.
