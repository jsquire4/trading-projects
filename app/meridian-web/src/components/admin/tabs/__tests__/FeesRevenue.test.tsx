import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const ADMIN_KEY = Keypair.generate().publicKey;
const FAKE_FEE_VAULT = Keypair.generate().publicKey;
const FAKE_TREASURY = Keypair.generate().publicKey;
const FAKE_CONFIG = Keypair.generate().publicKey;

vi.mock("@/lib/pda", () => ({
  findGlobalConfig: vi.fn(() => [FAKE_CONFIG, 255]),
  findFeeVault: vi.fn(() => [FAKE_FEE_VAULT, 254]),
  findTreasury: vi.fn(() => [FAKE_TREASURY, 253]),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSendTransaction = vi.fn().mockResolvedValue("sig123");

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({
    publicKey: ADMIN_KEY,
  })),
  useConnection: vi.fn(() => ({ connection: {} })),
  useAnchorWallet: vi.fn(() => null),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: null })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/hooks/useAnchorProgram", () => ({
  useAnchorProgram: vi.fn(() => ({
    program: {
      methods: {
        withdrawFees: vi.fn(() => ({
          accountsPartial: vi.fn(() => ({
            transaction: vi.fn().mockResolvedValue({}),
          })),
        })),
        withdrawTreasury: vi.fn(() => ({
          accountsPartial: vi.fn(() => ({
            transaction: vi.fn().mockResolvedValue({}),
          })),
        })),
        updateFeeBps: vi.fn(() => ({
          accountsPartial: vi.fn(() => ({
            transaction: vi.fn().mockResolvedValue({}),
          })),
        })),
        updateStrikeCreationFee: vi.fn(() => ({
          accountsPartial: vi.fn(() => ({
            transaction: vi.fn().mockResolvedValue({}),
          })),
        })),
      },
    },
    provider: {},
  })),
}));

vi.mock("@/hooks/useTransaction", () => ({
  useTransaction: vi.fn(() => ({
    sendTransaction: mockSendTransaction,
    status: "idle",
    error: null,
  })),
}));

let mockFeeVaultData: { balance: number; lamports: bigint } | null = null;
let mockTreasuryData: { balance: number; lamports: bigint } | null = null;
let mockConfigData: any = null;

vi.mock("@/hooks/useFeeVaultBalance", () => ({
  useFeeVaultBalance: vi.fn(() => ({ data: mockFeeVaultData })),
}));

vi.mock("@/hooks/useTreasuryBalance", () => ({
  useTreasuryBalance: vi.fn(() => ({ data: mockTreasuryData })),
}));

vi.mock("@/hooks/useGlobalConfig", () => ({
  useGlobalConfig: vi.fn(() => ({ data: mockConfigData })),
}));

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue(Keypair.generate().publicKey),
  TOKEN_PROGRAM_ID: Keypair.generate().publicKey,
}));

import { FeesRevenue } from "../FeesRevenue";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeesRevenue", () => {
  beforeEach(() => {
    mockSendTransaction.mockReset().mockResolvedValue("sig123");
    mockFeeVaultData = null;
    mockTreasuryData = null;
    mockConfigData = {
      feeBps: 50,
      strikeCreationFee: BigInt(1_000_000),
      obligations: BigInt(0),
      operatingReserve: BigInt(0),
      usdcMint: Keypair.generate().publicKey,
      admin: ADMIN_KEY,
    };
  });

  it("shows Withdraw All button disabled when fee vault is empty", () => {
    mockFeeVaultData = { balance: 0, lamports: BigInt(0) };
    render(<FeesRevenue />);
    const btn = screen.getByText("Withdraw All");
    expect(btn).toHaveProperty("disabled", true);
  });

  it("shows Withdraw All button disabled when fee vault is loading (null)", () => {
    mockFeeVaultData = null;
    render(<FeesRevenue />);
    const btn = screen.getByText("Withdraw All");
    expect(btn).toHaveProperty("disabled", true);
  });

  it("enables Withdraw All when fee vault has balance", () => {
    mockFeeVaultData = { balance: 12.5, lamports: BigInt(12_500_000) };
    render(<FeesRevenue />);
    const btn = screen.getByText("Withdraw All");
    expect(btn).toHaveProperty("disabled", false);
    expect(screen.getByText("$12.50")).toBeTruthy();
  });

  it("shows no surplus warning and disables withdraw when obligations exceed treasury", () => {
    mockFeeVaultData = { balance: 50, lamports: BigInt(50_000_000) };
    mockTreasuryData = { balance: 10, lamports: BigInt(10_000_000) };
    mockConfigData.obligations = BigInt(15_000_000); // $15 obligations > $10 treasury
    render(<FeesRevenue />);
    expect(screen.getByText(/No surplus available/)).toBeTruthy();
    // Treasury Withdraw button should be disabled when available <= 0
    const withdrawBtn = screen.getByText("Withdraw");
    expect(withdrawBtn).toHaveProperty("disabled", true);
  });

  it("shows available surplus when treasury exceeds obligations", () => {
    mockFeeVaultData = { balance: 50, lamports: BigInt(50_000_000) };
    mockTreasuryData = { balance: 100, lamports: BigInt(100_000_000) };
    mockConfigData.obligations = BigInt(20_000_000); // $20 obligations
    render(<FeesRevenue />);
    // Available = $100 - $20 - $0 reserve = $80
    expect(screen.getByText("$80.00")).toBeTruthy();
    expect(screen.queryByText(/No surplus available/)).toBeNull();
  });

  it("calls sendTransaction when Withdraw All is clicked", async () => {
    mockFeeVaultData = { balance: 12.5, lamports: BigInt(12_500_000) };
    render(<FeesRevenue />);
    const btn = screen.getByText("Withdraw All");
    fireEvent.click(btn);
    // Wait for async handler to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});
