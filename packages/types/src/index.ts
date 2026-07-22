// Core branded types for type safety
export type UUID = string & { readonly __brand: "uuid" };
export type ISODateString = string & { readonly __brand: "iso-date" };

// Domain enums
export type Role = "Artist" | "Producer";

// Money type for financial values
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

// Base user interface
export interface IUser {
  readonly id: UUID;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly isVerified?: boolean;
  readonly avatarUrl?: string;
}

// Extended producer profile with AI embedding data
export interface IProducerProfile extends IUser {
  readonly role: "Producer";
  readonly rate: Money;
  readonly bio: string;
  readonly genreTags: string[];
  readonly vibeEmbeddingVector: number[];
}

// Music track data structure
export interface IMusicTrack {
  readonly id: UUID;
  readonly producerId: UUID;
  readonly title: string;
  readonly s3Key: string;
  readonly durationSeconds: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

// AI query response structure for RAG
export interface IQueryResponse {
  readonly userQuery: string;
  readonly producerProfile: IProducerProfile;
  readonly aiMatchExplanation: string;
  readonly matchScore?: number;
}

// Utility type constructors for branded types
export const createUUID = (value: string): UUID => value as UUID;
export const createISODateString = (value: string): ISODateString => value as ISODateString;