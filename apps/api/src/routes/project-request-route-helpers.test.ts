/* eslint-disable @typescript-eslint/no-floating-promises */
// Shared route-helper unit tests for the ProjectRequest router.
//
// Background: ticket #62's Codex review P2-001 asked for
// helper-focused coverage of the shared route primitives so a
// future regression in a primitive (request-id resolution, session
// resolution, path / query-param reading, response-schema
// validation, error translation) is detected even if every
// endpoint-specific test happens to bypass it.
//
// These tests pin the helpers' contract end to end without booting
// the router. The endpoint-specific tests in
// `project-requests.test.ts` continue to cover the route integration.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Response } from "express";
import { z } from "zod";
import {
  resolveRequestId,
  resolveSessionForProjectRequest,
  readSessionCookie,
  readPathParamForProjectRequest,
  readActingWorkspaceIdFromQuery,
  readJsonBodyForProjectRequest,
  validateProjectRequestBody,
  validateProjectRequestResponse,
  translateProjectRequestServiceError,
  writeProjectRequestInternalError,
  writeProjectRequestQueryError,
} from "./project-request-route-helpers.js";
import { ProjectRequestError } from "../project-request/project-request.service.js";
import { AuthorizationError } from "../services/workspace-authorization.service.js";

interface CapturedResponse {
  status: number | null;
  body: { error?: { code?: string; message?: string } } | null;
  headers: Record<string, string>;
}

function makeMockResponse(): { res: Response; state: CapturedResponse } {
  const state: CapturedResponse = { status: null, body: null, headers: {} };
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers[name.toLowerCase()] = String(value);
      return this;
    },
    status(code: number) {
      state.status = code;
      return this;
    },
    json(value: unknown) {
      state.body = value as CapturedResponse["body"];
      return this;
    },
    writableEnded: false,
  } as unknown as Response;
  return { res, state };
}

describe("project-request-route-helpers", () => {
  describe("resolveRequestId", () => {
    test("uses the inbound header when it is a bounded string", () => {
      const req = { headers: { "x-request-id": "req-abc" } } as unknown as Parameters<
        typeof resolveRequestId
      >[0];
      const id = resolveRequestId(req);
      assert.equal(id, "req-abc");
    });

    test("generates a new id when the header is missing", () => {
      const req = { headers: {} } as unknown as Parameters<typeof resolveRequestId>[0];
      const id = resolveRequestId(req);
      assert.ok(typeof id === "string" && id.length > 0);
    });

    test("generates a new id when the header exceeds the 128-char cap", () => {
      const req = {
        headers: { "x-request-id": "x".repeat(200) },
      } as unknown as Parameters<typeof resolveRequestId>[0];
      const id = resolveRequestId(req);
      assert.notEqual(id, "x".repeat(200));
      assert.ok(typeof id === "string" && id.length > 0);
    });
  });

  describe("readSessionCookie", () => {
    test("decodes the bg1 session cookie verbatim", () => {
      const req = {
        headers: { cookie: "soundhub_session=abc%20123" },
      } as unknown as Parameters<typeof readSessionCookie>[0];
      assert.equal(readSessionCookie(req), "abc 123");
    });

    test("returns undefined when the cookie header is absent", () => {
      const req = { headers: {} } as unknown as Parameters<typeof readSessionCookie>[0];
      assert.equal(readSessionCookie(req), undefined);
    });
  });

  describe("resolveSessionForProjectRequest", () => {
    test("returns null when no session resolves", async () => {
      const { res } = makeMockResponse();
      const req = { headers: {} } as unknown as Parameters<
        typeof resolveSessionForProjectRequest
      >[0];
      const result = await resolveSessionForProjectRequest(
        req,
        res,
        { resolveSession: () => Promise.resolve(null) },
        "create a ProjectRequest",
      );
      assert.equal(result, null);
    });

    test("returns the userAccountId when the session resolves", async () => {
      const { res } = makeMockResponse();
      const req = { headers: {} } as unknown as Parameters<
        typeof resolveSessionForProjectRequest
      >[0];
      const result = await resolveSessionForProjectRequest(
        req,
        res,
        { resolveSession: () => Promise.resolve({ userAccountId: "u-1" }) },
        "create a ProjectRequest",
      );
      assert.deepEqual(result, { session: { userAccountId: "u-1" } });
    });
  });

  describe("readPathParamForProjectRequest", () => {
    test("returns the path param when present", () => {
      const { res } = makeMockResponse();
      const req = { params: { id: "pr-1" } } as unknown as Parameters<
        typeof readPathParamForProjectRequest
      >[1];
      assert.equal(readPathParamForProjectRequest(res, req, "id", "req-1"), "pr-1");
    });

    test("returns null and writes a safe envelope when the param is missing", () => {
      const { res, state } = makeMockResponse();
      const req = { params: {} } as unknown as Parameters<typeof readPathParamForProjectRequest>[1];
      const out = readPathParamForProjectRequest(res, req, "id", "req-1");
      assert.equal(out, null);
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
    });
  });

  describe("readActingWorkspaceIdFromQuery", () => {
    test("returns the query value when present", () => {
      const { res } = makeMockResponse();
      const req = { query: { actingWorkspaceId: "ws-1" } } as unknown as Parameters<
        typeof readActingWorkspaceIdFromQuery
      >[1];
      assert.equal(readActingWorkspaceIdFromQuery(res, req, "req-1"), "ws-1");
    });

    test("writes PROJECT_REQUEST_INVALID when missing", () => {
      const { res, state } = makeMockResponse();
      const req = { query: {} } as unknown as Parameters<typeof readActingWorkspaceIdFromQuery>[1];
      const out = readActingWorkspaceIdFromQuery(res, req, "req-1");
      assert.equal(out, null);
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
    });
  });

  describe("validateProjectRequestBody", () => {
    const schema = z.object({ actingWorkspaceId: z.string().min(1) }).strict();

    test("returns the parsed value when the schema accepts", () => {
      const { res } = makeMockResponse();
      const parsed = validateProjectRequestBody(
        res,
        schema,
        { actingWorkspaceId: "ws-1" },
        "req-1",
        "Test",
      );
      assert.deepEqual(parsed, { actingWorkspaceId: "ws-1" });
    });

    test("writes PROJECT_REQUEST_INVALID and returns null on schema failure", () => {
      const { res, state } = makeMockResponse();
      const parsed = validateProjectRequestBody(res, schema, { unrelated: true }, "req-1", "Test");
      assert.equal(parsed, null);
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
    });
  });

  describe("validateProjectRequestResponse", () => {
    const schema = z.object({ ok: z.literal(true) }).strict();

    test("writes the response when the schema accepts", () => {
      const { res, state } = makeMockResponse();
      const written = validateProjectRequestResponse(
        res,
        201,
        schema,
        { ok: true },
        "req-1",
        "create",
      );
      assert.equal(written, true);
      assert.equal(state.status, 201);
      assert.deepEqual(state.body, { ok: true });
    });

    test("writes the safe envelope when the schema rejects", () => {
      const { res, state } = makeMockResponse();
      // Schema requires { ok: true }; passing an empty object forces
      // a schema rejection and exercises the safe-envelope fallback.
      const written = validateProjectRequestResponse(
        res,
        201,
        schema,
        {} as { ok: true },
        "req-1",
        "create",
      );
      assert.equal(written, false);
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
    });
  });

  describe("translateProjectRequestServiceError", () => {
    test("maps ProjectRequestError to its code", () => {
      const { res, state } = makeMockResponse();
      const err = new ProjectRequestError("not allowed", "PROJECT_REQUEST_FORBIDDEN");
      const translated = translateProjectRequestServiceError(res, err, "req-1");
      assert.equal(translated, true);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_FORBIDDEN");
    });

    test("collapses AuthorizationError to PROJECT_REQUEST_FORBIDDEN", () => {
      const { res, state } = makeMockResponse();
      const err = new AuthorizationError("not a member", "NOT_A_MEMBER");
      const translated = translateProjectRequestServiceError(res, err, "req-1");
      assert.equal(translated, true);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_FORBIDDEN");
    });

    test("returns false for unknown error types so the caller writes an internal fallback", () => {
      const { res } = makeMockResponse();
      const translated = translateProjectRequestServiceError(res, new Error("boom"), "req-1");
      assert.equal(translated, false);
    });
  });

  describe("writeProjectRequestInternalError", () => {
    test("writes PROJECT_REQUEST_INVALID with the contextual message", () => {
      const { res, state } = makeMockResponse();
      writeProjectRequestInternalError(res, new Error("boom"), "req-1", "creating the request");
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
      assert.ok((state.body?.error?.message ?? "").includes("creating the request"));
    });
  });

  describe("writeProjectRequestQueryError", () => {
    test("writes PROJECT_REQUEST_INVALID with the supplied message", () => {
      const { res, state } = makeMockResponse();
      writeProjectRequestQueryError(res, "req-1", "status filter is invalid.");
      assert.equal(state.status, 400);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
      assert.equal(state.body?.error?.message, "status filter is invalid.");
    });
  });

  describe("readJsonBodyForProjectRequest", () => {
    test("returns the existing req.body when express.json already parsed it", async () => {
      const { res } = makeMockResponse();
      const req = { body: { actingWorkspaceId: "ws-1" } } as unknown as Parameters<
        typeof readJsonBodyForProjectRequest
      >[0];
      const parsed = await readJsonBodyForProjectRequest(req, res, "req-1");
      assert.deepEqual(parsed, { actingWorkspaceId: "ws-1" });
    });

    test("returns an empty object when there is no body and no chunks", async () => {
      const handlers: Record<string, (chunk?: Buffer) => void> = {};
      const { res } = makeMockResponse();
      const req = {
        body: undefined,
        on(event: string, cb: (chunk?: Buffer) => void) {
          handlers[event] = cb;
          return this;
        },
        pause: () => undefined,
      } as unknown as Parameters<typeof readJsonBodyForProjectRequest>[0];
      const parsedPromise = readJsonBodyForProjectRequest(req, res, "req-1");
      queueMicrotask(() => handlers["end"]?.());
      const parsed = await parsedPromise;
      assert.deepEqual(parsed, {});
    });

    test("returns null and writes PROJECT_REQUEST_INVALID on malformed JSON", async () => {
      const handlers: Record<string, (chunk?: Buffer) => void> = {};
      const { res, state } = makeMockResponse();
      const req = {
        body: undefined,
        on(event: string, cb: (chunk?: Buffer) => void) {
          handlers[event] = cb;
          return this;
        },
        pause: () => undefined,
      } as unknown as Parameters<typeof readJsonBodyForProjectRequest>[0];
      const parsedPromise = readJsonBodyForProjectRequest(req, res, "req-1");
      queueMicrotask(() => {
        handlers["data"]?.(Buffer.from("not-json"));
        handlers["end"]?.();
      });
      const parsed = await parsedPromise;
      assert.equal(parsed, null);
      assert.equal(state.body?.error?.code, "PROJECT_REQUEST_INVALID");
    });
  });
});
