/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import request from "supertest";
import express from "express";
import { createEscrowRouter, type EscrowService } from "./escrow.js";
import {
  createEscrowResponseV1Schema,
  escrowStateResponseV1Schema,
  escrowActionResponseV1Schema,
} from "@soundhub/types";

class MockEscrowService implements EscrowService {
  public initialized = false;
  public mockState = "Funded";
  public contractAddress = "0x48550a4bb374727186c55365b7c9c0a1a31bdafe";
  public signerAddress = "0x1111111111111111111111111111111111111111";

  async ensureInitialized(): Promise<void> {
    this.initialized = true;
  }

  async createEscrow(
    provider: string,
    arbitrator: string,
    duration: number,
    value?: string,
  ): Promise<{ contractAddress: string; blockHash: string }> {
    void provider;
    void arbitrator;
    void duration;
    void value;
    return {
      contractAddress: this.contractAddress,
      blockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };
  }

  async getState(targetAddress?: string): Promise<string> {
    void targetAddress;
    return this.mockState;
  }

  async releasePayment(targetAddress?: string): Promise<unknown> {
    void targetAddress;
    this.mockState = "Released";
    return "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  }

  async refundClient(targetAddress?: string): Promise<unknown> {
    void targetAddress;
    this.mockState = "Refunded";
    return "0xrefund1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  }

  async raiseDispute(targetAddress?: string): Promise<unknown> {
    void targetAddress;
    this.mockState = "Disputed";
    return "0xdispute123456789abcdef1234567890abcdef1234567890abcdef1234567890";
  }

  async getSignerAddress(): Promise<string> {
    return this.signerAddress;
  }
}

describe("Escrow API Routes", () => {
  test("GET /api/escrow/signer returns platform signer address", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).get("/api/escrow/signer");
    assert.equal(res.status, 200);
    assert.equal(res.body.address, service.signerAddress);
  });

  test("POST /api/escrow/create deploys a new escrow contract", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).post("/api/escrow/create").send({
      provider: "0x2222222222222222222222222222222222222222",
      duration: 86400,
    });

    assert.equal(res.status, 201);
    const parsed = createEscrowResponseV1Schema.parse(res.body);
    assert.equal(parsed.contractAddress, service.contractAddress);
    assert.ok(parsed.blockHash.startsWith("0x"));
  });

  test("POST /api/escrow/create returns 400 when required fields are missing", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).post("/api/escrow/create").send({
      provider: "", // invalid empty
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_SEARCH_CRITERIA");
  });

  test("GET /api/escrow/:address/state returns current contract state", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).get(`/api/escrow/${service.contractAddress}/state`);
    assert.equal(res.status, 200);
    const parsed = escrowStateResponseV1Schema.parse(res.body);
    assert.equal(parsed.address, service.contractAddress);
    assert.equal(parsed.state, "Funded");
  });

  test("POST /api/escrow/:address/release executes release and updates state", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).post(`/api/escrow/${service.contractAddress}/release`);
    assert.equal(res.status, 200);
    const parsed = escrowActionResponseV1Schema.parse(res.body);
    assert.equal(parsed.action, "release");
    assert.equal(parsed.state, "Released");
  });

  test("POST /api/escrow/:address/refund executes refund and updates state", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).post(`/api/escrow/${service.contractAddress}/refund`);
    assert.equal(res.status, 200);
    const parsed = escrowActionResponseV1Schema.parse(res.body);
    assert.equal(parsed.action, "refund");
    assert.equal(parsed.state, "Refunded");
  });

  test("POST /api/escrow/:address/dispute raises dispute and updates state", async () => {
    const service = new MockEscrowService();
    const app = express();
    app.use("/api/escrow", createEscrowRouter({ service }));

    const res = await request(app).post(`/api/escrow/${service.contractAddress}/dispute`);
    assert.equal(res.status, 200);
    const parsed = escrowActionResponseV1Schema.parse(res.body);
    assert.equal(parsed.action, "dispute");
    assert.equal(parsed.state, "Disputed");
  });
});
