// Public DTO mappers.
//
// Background: BG1 requires that the public Workspace and User shapes
// stay allow-listed and consistent across every layer that crosses
// the HTTP boundary. The route, the authentication service, and
// the workspace authorization service all need to emit the same
// buyer-safe shape, so the mapping is consolidated here. Any drift
// between the three call sites would silently leak a credential or
// internal id; this module is the single owner of that boundary.
//
// Privacy contract (per ADR 0004 and the BG1 ticket): provider
// subjects, claims, roles, and metadata NEVER cross a public DTO.
// Only the durable SoundHub UserAccount id and the buyer's
// workspaces are visible to the signed-in user.

import type { Bg1PublicUserV1, Bg1PublicWorkspaceV1 } from "@soundhub/types";
import type {
  PublicUserView,
  WorkspaceMembershipView,
} from "../auth-repository/auth-repository.js";

/**
 * Map an internal `PublicUserView` to the public buyer-facing user
 * shape. Strips `identitySubject` (the provider's opaque subject is
 * credential material) and emits only the fields the BG1 contract
 * allows.
 */
export function toPublicUser(user: PublicUserView): Bg1PublicUserV1 {
  return {
    userAccountId: user.userAccountId,
    email: user.email,
    displayName: user.displayName,
    identityProvider: user.identityProvider,
    // identitySubject intentionally omitted from the public DTO.
    workspaces: user.workspaces.map(toPublicWorkspace),
  };
}

/**
 * Map an internal `WorkspaceMembershipView` to the public
 * buyer-safe workspace shape. Spreads the capabilities array so the
 * caller cannot mutate the underlying view.
 */
export function toPublicWorkspace(view: WorkspaceMembershipView): Bg1PublicWorkspaceV1 {
  return {
    workspaceId: view.workspaceId,
    slug: view.slug,
    name: view.name,
    workspaceType: view.workspaceType,
    workspaceStatus: view.workspaceStatus,
    capabilities: [...view.capabilities],
  };
}
