import Link from "next/link";

export function Navigation() {
  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-8">
            <Link href="/" className="text-2xl font-bold text-blue-600 hover:text-blue-700">
              🎧 SoundHub
            </Link>
            <div className="hidden sm:flex sm:gap-4">
              <Link
                href="/"
                className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-blue-600 rounded-md hover:bg-gray-50 transition-colors"
              >
                Talent Search
              </Link>
              <Link
                href="/escrow"
                className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-blue-600 rounded-md hover:bg-gray-50 transition-colors flex items-center gap-1.5"
              >
                <span>🔒</span> Deal Escrow
              </Link>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
