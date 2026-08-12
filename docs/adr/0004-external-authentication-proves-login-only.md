---
status: accepted
---

# External authentication proves login only

SoundHub may delegate credential verification and session operation to a managed authentication
provider, but it owns the durable `UserAccount` identity and all marketplace authorization. A
provider identity is a replaceable credential mapping to a SoundHub UserAccount; provider subjects,
roles, and metadata never identify or authorize a Workspace.

## Consequences

- Replacing the provider may invalidate sessions but does not change UserAccount, Workspace,
  membership, seller, or marketplace identifiers.
- Authentication answers which human proved control of a login credential. SoundHub application
  services still verify the acting Workspace and current membership for every consequential action.
- Private email addresses and provider identifiers are not copied into public seller identity
  without explicit human action.
- Provider unavailability never permits an authentication or authorization bypass.
