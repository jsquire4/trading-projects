import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Stable test keys
// ---------------------------------------------------------------------------

const ADMIN_KEY = Keypair.generate().publicKey;
const OTHER_KEY = Keypair.generate().publicKey;

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({ publicKey: null, connected: false })),
  useConnection: vi.fn(() => ({ connection: {} })),
  useAnchorWallet: vi.fn(() => null),
}));

const mockGlobalConfigData = {
  admin: ADMIN_KEY,
  pendingAdmin: null,
  isPaused: false,
  oracleType: 0,
  feeBps: 50,
  strikeCreationFee: BigInt(1_000_000),
  operatingReserve: BigInt(0),
  obligations: BigInt(0),
  settlementBlackoutMinutes: 5,
  stalenessThreshold: BigInt(60),
  settlementStaleness: BigInt(120),
  confidenceBps: BigInt(50),
  tickers: ["AAPL"],
  tickerCount: 1,
  bump: 255,
  usdcMint: Keypair.generate().publicKey,
  oracleProgram: Keypair.generate().publicKey,
  publicKey: Keypair.generate().publicKey,
};

let mockConfigReturn: { data: typeof mockGlobalConfigData | null; isLoading: boolean } = {
  data: null,
  isLoading: false,
};

vi.mock("@/hooks/useGlobalConfig", () => ({
  useGlobalConfig: vi.fn(() => mockConfigReturn),
}));

// Stub child tab components
vi.mock("@/components/admin/tabs/AdminOverview", () => ({
  AdminOverview: () => <div data-testid="tab-overview">Overview Content</div>,
}));
vi.mock("@/components/admin/tabs/FeesRevenue", () => ({
  FeesRevenue: () => <div data-testid="tab-fees">Fees Content</div>,
}));
vi.mock("@/components/admin/tabs/MarketsPanel", () => ({
  MarketsPanel: () => <div data-testid="tab-markets">Markets Content</div>,
}));
vi.mock("@/components/admin/tabs/PlatformSettings", () => ({
  PlatformSettings: () => <div data-testid="tab-settings">Settings Content</div>,
}));
vi.mock("@/components/admin/tabs/TickerManagement", () => ({
  TickerManagement: () => <div data-testid="tab-tickers">Tickers Content</div>,
}));

import { useWallet } from "@solana/wallet-adapter-react";
import AdminPage from "../page";

const mockUseWallet = useWallet as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdminPage", () => {
  beforeEach(() => {
    mockConfigReturn = { data: null, isLoading: false };
    mockUseWallet.mockReturnValue({ publicKey: null, connected: false });
  });

  it("shows connect prompt when wallet is not connected", () => {
    render(<AdminPage />);
    expect(screen.getByText("Connect wallet to access admin controls.")).toBeTruthy();
    expect(screen.queryByTestId("tab-overview")).toBeNull();
  });

  it("shows access denied for non-admin wallet", () => {
    mockUseWallet.mockReturnValue({ publicKey: OTHER_KEY, connected: true });
    mockConfigReturn = { data: mockGlobalConfigData, isLoading: false };

    render(<AdminPage />);
    expect(screen.getByText("Only the protocol admin can access this page.")).toBeTruthy();
    expect(screen.queryByTestId("tab-overview")).toBeNull();
  });

  it("shows dashboard for admin wallet", () => {
    mockUseWallet.mockReturnValue({ publicKey: ADMIN_KEY, connected: true });
    mockConfigReturn = { data: mockGlobalConfigData, isLoading: false };

    render(<AdminPage />);
    expect(screen.getByText("Admin Dashboard")).toBeTruthy();
    expect(screen.getByTestId("tab-overview")).toBeTruthy();
  });

  it("shows loading state while config is fetching", () => {
    mockUseWallet.mockReturnValue({ publicKey: ADMIN_KEY, connected: true });
    mockConfigReturn = { data: null, isLoading: true };

    const { container } = render(<AdminPage />);
    expect(screen.queryByTestId("tab-overview")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("shows not-initialized message when config is null", () => {
    mockUseWallet.mockReturnValue({ publicKey: ADMIN_KEY, connected: true });
    mockConfigReturn = { data: null, isLoading: false };

    render(<AdminPage />);
    expect(screen.getByText("GlobalConfig not initialized. Run the CLI initialization script first.")).toBeTruthy();
  });

  it("shows Overview tab by default", () => {
    mockUseWallet.mockReturnValue({ publicKey: ADMIN_KEY, connected: true });
    mockConfigReturn = { data: mockGlobalConfigData, isLoading: false };

    render(<AdminPage />);
    expect(screen.getByTestId("tab-overview")).toBeTruthy();
    expect(screen.queryByTestId("tab-fees")).toBeNull();
  });

  it("switches tabs on click", () => {
    mockUseWallet.mockReturnValue({ publicKey: ADMIN_KEY, connected: true });
    mockConfigReturn = { data: mockGlobalConfigData, isLoading: false };

    render(<AdminPage />);
    expect(screen.getByTestId("tab-overview")).toBeTruthy();

    fireEvent.click(screen.getByText("Fees & Revenue"));
    expect(screen.queryByTestId("tab-overview")).toBeNull();
    expect(screen.getByTestId("tab-fees")).toBeTruthy();

    fireEvent.click(screen.getByText("Tickers"));
    expect(screen.queryByTestId("tab-fees")).toBeNull();
    expect(screen.getByTestId("tab-tickers")).toBeTruthy();
  });
});
