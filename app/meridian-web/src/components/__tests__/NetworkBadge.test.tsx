import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetworkBadge } from "../NetworkBadge";

// Mock useNetwork hook
vi.mock("@/hooks/useNetwork", () => ({
  useNetwork: vi.fn(),
}));

import { useNetwork } from "@/hooks/useNetwork";

const mockUseNetwork = useNetwork as ReturnType<typeof vi.fn>;

describe("NetworkBadge", () => {
  it("renders 'Devnet' badge with blue styling on devnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "devnet",
      isDevnet: true,
      isMainnet: false,
      isLocalnet: false,
      rpcUrl: "https://api.devnet.solana.com",
    });

    render(<NetworkBadge />);
    const badge = screen.getByText("Devnet");
    expect(badge).toBeDefined();
    expect(badge.className).toContain("blue");
  });

  it("renders 'Mainnet' badge with orange styling on mainnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "mainnet-beta",
      isDevnet: false,
      isMainnet: true,
      isLocalnet: false,
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    render(<NetworkBadge />);
    const badge = screen.getByText("Mainnet");
    expect(badge).toBeDefined();
    expect(badge.className).toContain("orange");
  });

  it("renders 'Local' badge with gray styling on localnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "localnet",
      isDevnet: false,
      isMainnet: false,
      isLocalnet: true,
      rpcUrl: "http://localhost:8899",
    });

    render(<NetworkBadge />);
    const badge = screen.getByText("Local");
    expect(badge).toBeDefined();
    expect(badge.className).toContain("gray");
  });
});
