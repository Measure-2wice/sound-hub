import type { Metadata } from "next";
import "./globals.css";
import { Navigation } from "./components/Navigation";

export const metadata: Metadata = {
  title: "SoundHub - AI Producer Marketplace",
  description: "Find producers by describing a vibe with AI-powered matching",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <Navigation />
        <main className="pt-4">
          {children}
        </main>
      </body>
    </html>
  );
}