---
status: accepted
---

# Sellers publish purchasable offerings

SoundHub distinguishes who a seller is (`SellerProfile`) from what buyers can commission
(`ServiceOffering`). Search returns one result per seller led by the best matching Active offering,
using controlled ServiceCategories plus seller-authored titles, descriptions, genres, and tags. This
adds modest Milestone 1 schema cost but avoids misrepresenting specialties or a single profile rate
as purchasable services.

## Consequences

- Pricing is optional, structured, and non-binding until copied into an approved TermsVersion.
- Each offering has one primary category and may name IncludedServices that are bundle-only.
  Independently purchasable work requires a separate offering.
- Offering lifecycle is `Draft | Active | Paused | Archived`; only Active offerings enter ordinary
  search, and stale results are revalidated before a ProjectRequest.
- CaribbeanAffiliation, current location, service area, genre, Specialty, and service mode remain
  distinct.
- PortfolioItem, private DealDeliverable, and future licensable catalog assets are separate
  concepts. Milestone 1 implements none of them and retires the ambiguous MusicTrack scaffold.
- Commissioning original work for sync is supported; licensing existing recordings or
  compositions is outside the MVP.
