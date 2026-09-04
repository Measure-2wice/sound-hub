import { EscrowPanel } from "../components/EscrowPanel";

export const metadata = {
  title: "Deal Escrow | SoundHub",
  description: "Manage smart contract escrows on Polkadot pallet-revive.",
};

export default function EscrowPage() {
  return (
    <div className="container mx-auto py-4">
      <EscrowPanel />
    </div>
  );
}
