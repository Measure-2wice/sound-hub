// Test-only helper: seed a recovery-bound UserAccount so the
// M2 #82 Playwright spec can exercise the recovery surface.
//
// A recovery-bound user has TWO Owner Personal Workspace
// memberships. The convergence service's
// classifyPersonalWorkspaceState then classifies this user as
// `recovery: multiple-personal-workspaces` on sign-in, which
// drives the browser to render the `RecoverySurface`.
//
// Run via:
//   apps/api/node_modules/.bin/tsx packages/db/prisma/seed-recovery-user.ts <email>

import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { deriveDeterministicSubject } from "@soundhub/types";
import { PrismaClient } from "../src/generated/client.js";

const email = process.argv[2];
const url = process.env.TEST_DATABASE_URL;
if (!email || !url) {
  console.error("Usage: seed-recovery-user.ts <email> (requires TEST_DATABASE_URL)");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

try {
  const existing = await prisma.userAccount.findFirst({ where: { email } });
  if (existing) {
    await prisma.userAccount.update({
      where: { id: existing.id },
      data: { personalWorkspaceId: null },
    });
    await prisma.workspaceMembership.deleteMany({ where: { userId: existing.id } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: existing.id } });
    await prisma.identityProvider.deleteMany({ where: { userAccountId: existing.id } });
    await prisma.userAccount.delete({ where: { id: existing.id } });
  }
  const sha256 = (i: string) => createHash("sha256").update(i).digest("hex");
  const subject = deriveDeterministicSubject(email, sha256);

  const user = await prisma.userAccount.create({ data: { email } });
  await prisma.identityProvider.create({
    data: {
      provider: "deterministic",
      subject,
      providerEmail: email,
      userAccountId: user.id,
    },
  });
  const ts = Date.now();
  const ws1 = await prisma.workspace.create({
    data: {
      slug: `recovery-personal-1-${ts}`,
      name: "Recovery Personal 1",
      type: "Personal",
      status: "Active",
      ownerUserId: user.id,
    },
  });
  const ws2 = await prisma.workspace.create({
    data: {
      slug: `recovery-personal-2-${ts}`,
      name: "Recovery Personal 2",
      type: "Personal",
      status: "Active",
      ownerUserId: user.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: { userId: user.id, workspaceId: ws1.id, role: "Owner" },
  });
  await prisma.workspaceMembership.create({
    data: { userId: user.id, workspaceId: ws2.id, role: "Owner" },
  });
  console.log(`✓ seeded recovery-bound user: ${email} (id=${user.id})`);
} finally {
  await prisma.$disconnect();
}
