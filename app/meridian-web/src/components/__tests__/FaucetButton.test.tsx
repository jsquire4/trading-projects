import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FaucetButton } from "../FaucetButton";

// Mock useNetwork
vi.mock("@/hooks/useNetwork", () => ({
  useNetwork: vi.fn(),
}));

// Mock wallet adapter
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({ publicKey: null })),
}));

// Mock sonner
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useNetwork } from "@/hooks/useNetwork";
import { useWallet } from "@solana/wallet-adapter-react";

const mockUseNetwork = useNetwork as ReturnType<typeof vi.fn>;
const mockUseWallet = useWallet as ReturnType<typeof vi.fn>;

describe("FaucetButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders on devnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "devnet",
      isMainnet: false,
      isDevnet: true,
      isLocalnet: false,
      rpcUrl: "https://api.devnet.solana.com",
    });
    mockUseWallet.mockReturnValue({ publicKey: null });

    render(<FaucetButton />);
    expect(screen.getByText("Get Test USDC")).toBeDefined();
  });

  it("renders on localnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "localnet",
      isMainnet: false,
      isDevnet: false,
      isLocalnet: true,
      rpcUrl: "http://localhost:8899",
    });
    mockUseWallet.mockReturnValue({ publicKey: null });

    render(<FaucetButton />);
    expect(screen.getByText("Get Test USDC")).toBeDefined();
  });

  it("is hidden on mainnet", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "mainnet-beta",
      isMainnet: true,
      isDevnet: false,
      isLocalnet: false,
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
    mockUseWallet.mockReturnValue({ publicKey: null });

    const { container } = render(<FaucetButton />);
    expect(container.innerHTML).toBe("");
  });

  it("is disabled when no wallet connected", () => {
    mockUseNetwork.mockReturnValue({
      cluster: "devnet",
      isMainnet: false,
      isDevnet: true,
      isLocalnet: false,
      rpcUrl: "https://api.devnet.solana.com",
    });
    mockUseWallet.mockReturnValue({ publicKey: null });

    render(<FaucetButton />);
    const button = screen.getByText("Get Test USDC");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
