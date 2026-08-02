import type { IQueryResponse, IProducerProfile, PublicProducerProfile } from "@soundhub/types";
import { createUUID, createISODateString } from "@soundhub/types";

/**
 * RagService handles AI-powered producer matching using embeddings and semantic search.
 *
 * In a production implementation, this would:
 * 1. Generate embeddings for user queries using OpenAI
 * 2. Perform vector similarity search in Pinecone
 * 3. Retrieve producer profiles from the database
 * 4. Generate AI explanations for matches
 */
export class RagService {
  private mockProducers: IProducerProfile[] = [
    {
      id: createUUID("producer-1"),
      email: "darkbeats@example.com",
      displayName: "DarkSynth Producer",
      role: "Producer",
      createdAt: createISODateString("2024-01-15T10:00:00Z"),
      updatedAt: createISODateString("2024-01-15T10:00:00Z"),
      isVerified: true,
      rate: { amountMinor: 30000, currency: "USD" },
      bio: "Specializing in dark atmospheric beats with heavy bass and industrial elements",
      genreTags: ["Dark Electronic", "Industrial", "Trap", "Bass"],
      vibeEmbeddingVector: Array.from({ length: 1536 }, () => Math.random() - 0.5),
    },
    {
      id: createUUID("producer-2"),
      email: "chillvibes@example.com",
      displayName: "ChillWave Studio",
      role: "Producer",
      createdAt: createISODateString("2024-01-10T14:30:00Z"),
      updatedAt: createISODateString("2024-01-10T14:30:00Z"),
      isVerified: true,
      rate: { amountMinor: 25000, currency: "USD" },
      bio: "Creating dreamy, ambient soundscapes perfect for relaxation and meditation",
      genreTags: ["Ambient", "Chillwave", "Lo-Fi", "Downtempo"],
      vibeEmbeddingVector: Array.from({ length: 1536 }, () => Math.random() - 0.5),
    },
    {
      id: createUUID("producer-3"),
      email: "hiphopmixer@example.com",
      displayName: "Urban Flow Beats",
      role: "Producer",
      createdAt: createISODateString("2024-01-20T09:15:00Z"),
      updatedAt: createISODateString("2024-01-20T09:15:00Z"),
      isVerified: true,
      rate: { amountMinor: 35000, currency: "USD" },
      bio: "Classic boom-bap and modern trap fusion with crisp drums and smooth samples",
      genreTags: ["Hip-Hop", "Trap", "Boom-Bap", "R&B"],
      vibeEmbeddingVector: Array.from({ length: 1536 }, () => Math.random() - 0.5),
    },
  ];

  /**
   * Search for producers matching the given query using semantic similarity
   */
  async searchProducers(query: string): Promise<IQueryResponse[]> {
    // Simulate AI processing delay
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

    // Mock semantic matching based on keywords
    const results: IQueryResponse[] = [];
    const queryLower = query.toLowerCase();

    for (const producer of this.mockProducers) {
      const matchScore = this.calculateMockMatchScore(queryLower, producer);

      if (matchScore > 0.3) {
        // Threshold for relevance
        results.push({
          userQuery: query,
          producerProfile: this.toPublicProducerProfile(producer),
          aiMatchExplanation: this.generateMockExplanation(queryLower, producer, matchScore),
          matchScore,
        });
      }
    }

    // Sort by match score (highest first)
    return results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  }

  private toPublicProducerProfile(producer: IProducerProfile): PublicProducerProfile {
    return {
      id: producer.id,
      email: producer.email,
      displayName: producer.displayName,
      role: producer.role,
      createdAt: producer.createdAt,
      updatedAt: producer.updatedAt,
      isVerified: producer.isVerified,
      avatarUrl: producer.avatarUrl,
      rate: producer.rate,
      bio: producer.bio,
      genreTags: producer.genreTags,
    };
  }

  /**
   * Mock similarity calculation based on keyword matching
   * In production, this would use actual vector similarity (cosine distance)
   */
  private calculateMockMatchScore(query: string, producer: IProducerProfile): number {
    let score = 0;

    // Check genre tag matches
    const genreMatches = producer.genreTags.filter(
      (tag) => query.includes(tag.toLowerCase()) || tag.toLowerCase().includes(query),
    );
    score += genreMatches.length * 0.3;

    // Check bio description matches
    const bioWords = producer.bio.toLowerCase().split(" ");
    const queryWords = query.split(" ");

    const bioMatches = queryWords.filter((word) =>
      bioWords.some((bioWord) => bioWord.includes(word) || word.includes(bioWord)),
    );
    score += bioMatches.length * 0.2;

    // Add some randomness to simulate vector similarity
    score += Math.random() * 0.3;

    return Math.min(score, 1.0); // Cap at 1.0
  }

  /**
   * Generate AI explanation for why this producer matches the query
   * In production, this would use GPT to generate contextual explanations
   */
  private generateMockExplanation(
    query: string,
    producer: IProducerProfile,
    matchScore: number,
  ): string {
    const explanations = [
      `${producer.displayName} is an excellent match for "${query}" because their production style aligns perfectly with your vision. ${producer.bio}`,
      `Based on your request for "${query}", ${producer.displayName} stands out with their expertise in ${producer.genreTags.slice(0, 2).join(" and ")} production.`,
      `The vibe you're looking for ("${query}") matches ${producer.displayName}'s signature sound. Their portfolio demonstrates strong capability in creating the atmosphere you've described.`,
    ];

    const baseExplanation = explanations[Math.floor(Math.random() * explanations.length)];

    if (matchScore > 0.8) {
      return `🎯 Perfect Match! ${baseExplanation} This producer has extensive experience creating exactly what you're looking for.`;
    } else if (matchScore > 0.6) {
      return `✨ Great Match! ${baseExplanation} Their style shows strong alignment with your creative direction.`;
    } else {
      return `👍 Good Match! ${baseExplanation} While not a perfect fit, their versatility could bring an interesting perspective to your project.`;
    }
  }
}
