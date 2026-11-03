import type { NextConfig } from "next";

// DB_PATH (the shared SQLite file, optional) comes from the environment or .env.local, which Next loads.
const nextConfig: NextConfig = {
  // The dev badge's default corner (bottom-left) covers the sidebar's theme toggle.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
