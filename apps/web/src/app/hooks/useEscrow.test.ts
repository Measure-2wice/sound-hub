/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createEscrowRequestV1Schema,
  createEscrowResponseV1Schema,
  escrowStateResponseV1Schema,
  escrowActionResponseV1Schema,
} from "@soundhub/types";

describe("Escrow Zod Schemas", () => {
  test("createEscrowRequestV1Schema accepts valid payload", () => {
    const valid = {
      provider: "0x2222222222222222222222222222222222222222",
      duration: 3600,
    };
    const parsed = createEscrowRequestV1Schema.parse(valid);
    assert.equal(parsed.provider, valid.provider);
    assert.equal(parsed.duration, 3600);
  });

  test("createEscrowRequestV1Schema rejects negative or zero duration", () => {
    assert.throws(() => {
      createEscrowRequestV1Schema.parse({
        provider: "0x2222222222222222222222222222222222222222",
        duration: -10,
      });
    });
  });

  test("createEscrowResponseV1Schema accepts valid deployment payload", () => {
    const valid = {
      contractAddress: "0x48550a4bb374727186c55365b7c9c0a1a31bdafe",
      blockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };
    const parsed = createEscrowResponseV1Schema.parse(valid);
    assert.equal(parsed.contractAddress, valid.contractAddress);
    assert.equal(parsed.blockHash, valid.blockHash);
  });

  test("escrowStateResponseV1Schema parses valid states", () => {
    const states = ["Funded", "Disputed", "Released", "Refunded", "Unknown"] as const;
    for (const state of states) {
      const parsed = escrowStateResponseV1Schema.parse({
        address: "0x48550a4bb374727186c55365b7c9c0a1a31bdafe",
        state,
      });
      assert.equal(parsed.state, state);
    }
  });

  test("escrowActionResponseV1Schema parses valid action results", () => {
    const parsed = escrowActionResponseV1Schema.parse({
      address: "0x48550a4bb374727186c55365b7c9c0a1a31bdafe",
      action: "release",
      blockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      state: "Released",
    });
    assert.equal(parsed.action, "release");
    assert.equal(parsed.state, "Released");
  });
});
