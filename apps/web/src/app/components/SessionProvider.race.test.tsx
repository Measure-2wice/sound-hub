/* eslint-disable @typescript-eslint/no-floating-promises */
// SessionProvider race coverage (Codex review, session refresh / sign-out race).
//
// Background: a previous version of `SessionProvider.refresh()` called
// `setUser(info.user)` unconditionally on every `fetchSessionInfo`
// resolution. If a user-initiated sign-out (or any newer auth
// action) started AFTER an older `refresh()` call had been issued,
// the older fetch could resolve AFTER the newer state was applied —
// resurrecting a signed-out user in the navigation / dashboard.
// The same hazard applied to two overlapping refreshes: the slower
// response would overwrite the fresher one.
//
// The fix introduces a monotonic operation-generation counter on
// `SessionProvider`. Every operation that may eventually call
// `setUser` (`refresh`, the mount-time initial fetch, and the
// post-signout / post-verify re-pulls inside `signOutAndRefresh` /
// `verifyAndRefresh`) bumps the counter BEFORE awaiting, and only
// commits its result if its bumped value is still current.
//
// These tests pin the four invariants the owner requires:
//   1. A normal `refresh()` updates `user`.
//   2. A stale older refresh that resolves AFTER a successful
//      sign-out cannot restore the prior user — final `user` is
//      null.
//   3. Overlapping refreshes — the earlier response cannot
//      overwrite the newer state.
//   4. Existing verify / sign-out behavior remains intact
//      (no regression in the happy paths).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Bg1PublicUserV1, Bg1SessionInfoV1 } from "@soundhub/types";

import { SessionProvider, useSession } from "./SessionProvider";

// ---- Helpers -----------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeUser(id: string): Bg1PublicUserV1 {
  // Schema-compliant user payload for Bg1SessionInfoV1.
  return {
    userAccountId: id,
    email: `${id}@example.test`,
    displayName: id,
    identityProvider: "deterministic",
    workspaces: [],
    setupState: "converged",
  } as unknown as Bg1PublicUserV1;
}

function makeSessionInfo(user: Bg1PublicUserV1 | null): Bg1SessionInfoV1 {
  return { user };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mounts a SessionProvider into a container, returns:
 *   - `mount(container, opts)`: renders the provider, resolves the
 *     mount-time fetch (if a deferred is supplied), flushes microtasks
 *   - `getUser()`: reads the current user from a Reader component
 *     inside the provider subtree
 *   - `dispose()`: unmounts both roots and removes their containers
 */
function mountSessionProvider(): {
  mount: (mountFetch: Deferred<Bg1SessionInfoV1>) => Promise<void>;
  getUser: () => Bg1PublicUserV1 | null;
  captureContext: () => {
    refresh: () => Promise<void>;
    signOutAndRefresh: () => Promise<void>;
  };
  getMeRequestCount: () => number;
  setSignOutHandler: (handler: { signOutDeferred: Deferred<void> }) => void;
  setMeHandler: (
    handler: (reqIndex: number) => {
      deferred: Deferred<Bg1SessionInfoV1>;
      user: Bg1PublicUserV1 | null;
    }[],
  ) => void;
  dispose: () => void;
} {
  let snapshot: { user: Bg1PublicUserV1 | null; loading: boolean } = {
    user: null,
    loading: true,
  };
  let ctxRef: {
    refresh: () => Promise<void>;
    signOutAndRefresh: () => Promise<void>;
  } | null = null;
  let meRequestCount = 0;
  // Programmable per-/me-response queue, indexed 0-based by request order.
  let meQueue: { deferred: Deferred<Bg1SessionInfoV1>; user: Bg1PublicUserV1 | null }[] = [];
  let signOutDeferred: Deferred<void> | null = null;

  function Reader(): null {
    const ctx = useSession();
    ctxRef = ctx;
    snapshot = { user: ctx.user, loading: ctx.loading };
    return null;
  }

  const providerContainer = document.createElement("div");
  document.body.appendChild(providerContainer);
  let providerRoot: Root | null = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/auth/sign-out")) {
      if (signOutDeferred) await signOutDeferred.promise;
      return jsonResponse({ ok: true });
    }
    if (url.endsWith("/api/auth/me")) {
      const idx = meRequestCount;
      meRequestCount += 1;
      const slot = meQueue[idx];
      if (!slot) throw new Error(`unexpected /me request #${idx} (no queue entry)`);
      await slot.deferred.promise;
      return jsonResponse(makeSessionInfo(slot.user));
    }
    return new Response("{}", { status: 500 });
  });

  return {
    async mount(mountFetch: Deferred<Bg1SessionInfoV1>) {
      // The /me queue is set BEFORE mount via setMeHandler.
      // setMeHandler also resets meRequestCount.
      providerRoot = createRoot(providerContainer);
      await act(async () => {
        providerRoot!.render(createElement(SessionProvider, null, createElement(Reader)));
        await flushMicrotasks();
      });
      // Resolve mount fetch and flush again so the Reader re-renders
      // with the post-mount user state.
      await act(async () => {
        mountFetch.resolve(makeSessionInfo(meQueue[0]!.user));
        await flushMicrotasks();
      });
    },
    getUser: () => snapshot.user,
    captureContext: () => {
      if (!ctxRef) throw new Error("context not captured");
      return ctxRef;
    },
    getMeRequestCount: () => meRequestCount,
    setSignOutHandler: ({ signOutDeferred: d }) => {
      signOutDeferred = d;
    },
    setMeHandler: (handler) => {
      meQueue = handler(0);
      meRequestCount = 0;
    },
    dispose: () => {
      globalThis.fetch = originalFetch;
      if (providerRoot) providerRoot.unmount();
      providerContainer.remove();
    },
  };
}

// ---- Tests -------------------------------------------------------------

describe("SessionProvider — operation-generation guard (race fix)", () => {
  let harness: ReturnType<typeof mountSessionProvider> | null = null;

  beforeEach(() => {
    // Each test mounts a fresh harness so global.fetch is set up.
  });

  afterEach(() => {
    if (harness) {
      harness.dispose();
      harness = null;
    }
  });

  test("refresh() updates user normally (happy path regression)", async () => {
    const mountFetch = deferred<Bg1SessionInfoV1>();
    const refreshFetch = deferred<Bg1SessionInfoV1>();
    harness = mountSessionProvider();
    harness.setMeHandler(() => [
      { deferred: mountFetch, user: null }, // mount: anonymous
      { deferred: refreshFetch, user: makeUser("userX") }, // refresh
    ]);
    await harness.mount(mountFetch);
    assert.equal(harness.getUser(), null, "mount: anonymous user");

    // Drive a refresh; it MUST update the user to userX.
    await act(async () => {
      const ctx = harness!.captureContext();
      const p = ctx.refresh();
      refreshFetch.resolve(makeSessionInfo(makeUser("userX")));
      await p;
      await flushMicrotasks();
    });
    assert.equal(
      harness.getUser()?.userAccountId,
      "userX",
      "refresh MUST update user to the resolved session",
    );
  });

  test("slow old refresh that resolves AFTER sign-out cannot resurrect the prior user", async () => {
    const mountFetch = deferred<Bg1SessionInfoV1>();
    const oldRefreshFetch = deferred<Bg1SessionInfoV1>();
    const postSignoutFetch = deferred<Bg1SessionInfoV1>();
    const signOutDeferred = deferred<void>();

    harness = mountSessionProvider();
    harness.setMeHandler(() => [
      { deferred: mountFetch, user: makeUser("userA") }, // 1: mount
      { deferred: oldRefreshFetch, user: makeUser("userA") }, // 2: OLD refresh (slow)
      { deferred: postSignoutFetch, user: null }, // 3: post-signout
    ]);
    harness.setSignOutHandler({ signOutDeferred });

    await harness.mount(mountFetch);
    assert.equal(harness.getUser()?.userAccountId, "userA", "after mount: userA");

    // Launch OLD refresh (will not resolve until we say so).
    let oldRefreshDone!: () => void;
    const oldRefreshFinished = new Promise<void>((res) => {
      oldRefreshDone = res;
    });
    const oldRefreshStart = (async () => {
      const ctx = harness.captureContext();
      await ctx.refresh();
      oldRefreshDone();
    })();
    await flushMicrotasks();
    assert.equal(harness.getMeRequestCount(), 2, "old refresh issued its /me fetch");

    // Launch signOutAndRefresh in parallel.
    const signOutStart = (async () => {
      const ctx = harness.captureContext();
      await ctx.signOutAndRefresh();
    })();
    await flushMicrotasks();
    // signOut is in flight; resolve it AND the post-signout /me fetch.
    await act(async () => {
      signOutDeferred.resolve();
      postSignoutFetch.resolve(makeSessionInfo(null));
      await signOutStart;
      await flushMicrotasks();
    });
    assert.equal(harness.getUser(), null, "after signOutAndRefresh: user is null");

    // NOW resolve the OLD refresh — without the generation guard it
    // would resurrect userA.
    await act(async () => {
      oldRefreshFetch.resolve(makeSessionInfo(makeUser("userA")));
      await oldRefreshFinished;
      await oldRefreshStart;
      await flushMicrotasks();
    });

    assert.equal(
      harness.getUser(),
      null,
      "stale OLD refresh that resolved AFTER sign-out MUST NOT resurrect the prior user",
    );
  });

  test("overlapping refreshes — earlier response cannot overwrite newer state", async () => {
    const mountFetch = deferred<Bg1SessionInfoV1>();
    const firstRefreshFetch = deferred<Bg1SessionInfoV1>();
    const secondRefreshFetch = deferred<Bg1SessionInfoV1>();

    harness = mountSessionProvider();
    harness.setMeHandler(() => [
      { deferred: mountFetch, user: null }, // 1: mount
      { deferred: firstRefreshFetch, user: makeUser("first") }, // 2: first
      { deferred: secondRefreshFetch, user: makeUser("second") }, // 3: second
    ]);

    await harness.mount(mountFetch);
    assert.equal(harness.getUser(), null, "initial: anonymous");

    // Launch BOTH refreshes. Resolve the SECOND one first.
    let firstRefreshDone!: () => void;
    const firstRefreshFinished = new Promise<void>((res) => {
      firstRefreshDone = res;
    });
    const firstStart = (async () => {
      const ctx = harness.captureContext();
      await ctx.refresh();
      firstRefreshDone();
    })();
    const secondStart = (async () => {
      const ctx = harness.captureContext();
      await ctx.refresh();
    })();
    await flushMicrotasks();
    assert.equal(harness.getMeRequestCount(), 3, "both refresh fetches issued");

    // Resolve the second one first.
    await act(async () => {
      secondRefreshFetch.resolve(makeSessionInfo(makeUser("second")));
      await secondStart;
      await flushMicrotasks();
    });
    assert.equal(
      harness.getUser()?.userAccountId,
      "second",
      "after second resolves, user is 'second'",
    );

    // NOW resolve the first one — it would overwrite 'second' if the
    // generation guard weren't in place.
    await act(async () => {
      firstRefreshFetch.resolve(makeSessionInfo(makeUser("first")));
      await firstRefreshFinished;
      await firstStart;
      await flushMicrotasks();
    });

    assert.equal(
      harness.getUser()?.userAccountId,
      "second",
      "stale earlier refresh MUST NOT overwrite the newer state — user stays 'second'",
    );
  });

  test("existing sign-out happy path remains intact (no regression)", async () => {
    const mountFetch = deferred<Bg1SessionInfoV1>();
    const postSignoutFetch = deferred<Bg1SessionInfoV1>();
    const signOutDeferred = deferred<void>();

    harness = mountSessionProvider();
    harness.setMeHandler(() => [
      { deferred: mountFetch, user: makeUser("userA") }, // 1: mount
      { deferred: postSignoutFetch, user: null }, // 2: post-signout
    ]);
    harness.setSignOutHandler({ signOutDeferred });

    await harness.mount(mountFetch);
    assert.equal(harness.getUser()?.userAccountId, "userA", "after mount: userA");

    // Drive sign-out + post-signout /me fetch.
    await act(async () => {
      const ctx = harness!.captureContext();
      const p = ctx.signOutAndRefresh();
      await flushMicrotasks();
      signOutDeferred.resolve();
      postSignoutFetch.resolve(makeSessionInfo(null));
      await p;
    });

    assert.equal(harness.getUser(), null, "after signOutAndRefresh: user is null");
  });
});
