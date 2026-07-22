import { PrismaClient } from "../dist/generated/index.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // Create a sample producer user
  const producerUser = await prisma.user.create({
    data: {
      email: "producer@example.com",
      displayName: "Sample Producer",
      role: "Producer",
      isVerified: true,
    },
  });

  // Create producer profile with sample data
  const producerProfile = await prisma.producerProfile.create({
    data: {
      userId: producerUser.id,
      rateAmountMinor: 25000, // $250.00
      rateCurrency: "USD",
      bio: "Award-winning producer specializing in electronic and hip-hop beats",
      genreTags: ["Electronic", "Hip-Hop", "Trap", "Ambient"],
      vibeEmbeddingVector: Array.from({ length: 1536 }, () => Math.random() - 0.5), // Sample OpenAI embedding size
    },
  });

  // Create sample music tracks
  await prisma.musicTrack.createMany({
    data: [
      {
        producerId: producerProfile.id,
        title: "Midnight Vibes",
        s3Key: "tracks/midnight-vibes.mp3",
        durationSeconds: 180,
      },
      {
        producerId: producerProfile.id,
        title: "Urban Flow",
        s3Key: "tracks/urban-flow.mp3",
        durationSeconds: 210,
      },
    ],
  });

  // Create a sample artist user
  await prisma.user.create({
    data: {
      email: "artist@example.com",
      displayName: "Sample Artist",
      role: "Artist",
      isVerified: true,
    },
  });

  console.log("✅ Database seeded successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });