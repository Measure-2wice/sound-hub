/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import assert from "node:assert/strict";
import * as c from "./backend.service";

const test = async () => {
  try {
    await c.init();
    const arbitrator = await c.getSignerAddress();
    const provider = "0x2222222222222222222222222222222222222222";

    const deployment = await c.createEscrow(provider, arbitrator, 100);
    console.log("Deployed escrow:", deployment);

    const pendingState = await c.getState();
    assert.equal(pendingState, "Funded", "new escrow should start in Funded");
    console.log("Initial state:", pendingState);

    const releaseTx = await c.releasePayment();
    console.log("release_payment tx:", releaseTx);

    const finalState = await c.getState();
    assert.equal(finalState, "Released", "release_payment should settle the escrow as Released");
    console.log("State after release_payment:", finalState);

    console.log("release_payment test passed");
  } finally {
    await c.disconnect();
  }
};

test().catch((error) => {
  console.error(error);
  process.exit(1);
});
