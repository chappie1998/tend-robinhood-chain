import { Activity, Copy, ExternalLink, Fuel, LayoutDashboard, LogOut, Menu, TrendingUp, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN_BRAND, CHAIN_LABEL, EXPLORER_URL, GAS_FAUCET_URL, GAS_TOKEN, monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";

// If a wallet's injected provider never settles the connection request (some
// extensions swallow errors internally instead of rejecting the promise),
// don't leave the button reading "Connecting…" forever with no way out.
const CONNECT_STALL_MS = 10_000;


export type AppView = "trade" | "portfolio" | "earn";

const NAV_ITEMS: readonly { id: AppView; label: string; icon: typeof Activity }[] = [
  { id: "trade", label: "Trade", icon: Activity },
  { id: "portfolio", label: "Portfolio", icon: LayoutDashboard },
  { id: "earn", label: "Write & earn", icon: TrendingUp },
];

export function Logo() {
  return (
    <div className="logo" aria-label="Tend">
      <span className="logo-mark" aria-hidden="true">t</span>
      <span>tend</span>
    </div>
  );
}

function ProductNav({ active, onChange }: { active: AppView; onChange: (view: AppView) => void }) {
  return (
    <nav className="product-nav" aria-label="Product">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={active === id ? "nav-item active" : "nav-item"}
          onClick={() => onChange(id)}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * The top bar, ported from the Solana terminal: logo, centred product nav,
 * network pill and one wallet control. Connection problems render as a
 * dismissible full-width band under the bar rather than loose text beside
 * the button, which is what used to push the bar out of shape.
 */
export function Header({ view, onNavigate }: { view: AppView; onNavigate: (view: AppView) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [walletError, setWalletError] = useState("");
  const [stalled, setStalled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const walletMenuRef = useRef<HTMLDivElement>(null);

  const wrongNetwork = isConnected && chainId !== monadTestnet.id;
  const menuVisible = walletMenuOpen && isConnected && Boolean(address);

  useEffect(() => {
    if (!isConnecting) return;
    const timer = setTimeout(() => setStalled(true), CONNECT_STALL_MS);
    return () => clearTimeout(timer);
  }, [isConnecting]);

  // The wallet menu has no backdrop, so an outside click is the only way to
  // dismiss it besides choosing an item.
  useEffect(() => {
    if (!menuVisible) return;
    const onPointerDown = (event: PointerEvent) => {
      if (walletMenuRef.current && !walletMenuRef.current.contains(event.target as Node)) setWalletMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuVisible]);

  function handleConnect() {
    setWalletError("");
    setStalled(false);
    const hasInjectedProvider = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
    if (!hasInjectedProvider) {
      setWalletError("No browser wallet detected. Install an EVM wallet such as MetaMask or Rabby, then reload this page.");
      return;
    }
    const connector = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (!connector) {
      setWalletError("No wallet connector available.");
      return;
    }
    connect({ connector }, { onError: (error) => setWalletError(toUserMessage(error)) });
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context) — nothing worth surfacing.
    }
  }

  const connecting = isConnecting && !stalled;
  const walletLabel = connecting
    ? "Connecting…"
    : isConnected && address
      ? `${address.slice(0, 6)}…${address.slice(-4)}`
      : "Connect wallet";

  return (
    <>
      <header className="topbar">
        <Logo />
        <div className="desktop-nav">
          <ProductNav active={view} onChange={onNavigate} />
        </div>
        <div className="header-actions">
          <div className="network-pill" title={`${CHAIN_LABEL} · chain ${monadTestnet.id}`}>
            <span />
            <strong>{CHAIN_BRAND}</strong>
            <small>Testnet · mUSDC</small>
          </div>
          <div className="wallet-control" ref={walletMenuRef}>
            <button
              type="button"
              className={isConnected ? (wrongNetwork ? "wallet-button wrong-network" : "wallet-button connected") : "wallet-button"}
              onClick={() => (isConnected ? setWalletMenuOpen((open) => !open) : handleConnect())}
              disabled={connecting}
              aria-busy={connecting}
              aria-haspopup={isConnected ? "menu" : undefined}
              aria-expanded={isConnected ? menuVisible : undefined}
            >
              <Wallet size={16} aria-hidden="true" /> {walletLabel}
            </button>
            {menuVisible && address && (
              <div className="wallet-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => void copyAddress()}>
                  <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy address"}
                </button>
                <a
                  role="menuitem"
                  href={`${EXPLORER_URL}/address/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setWalletMenuOpen(false)}
                >
                  <ExternalLink size={14} aria-hidden="true" /> View on explorer
                </a>
                {/* Gas is debited upfront here, so an empty wallet fails with a
                    blank revert — the faucet stays one click from the address.
                    Omitted entirely on a chain with no published faucet, rather
                    than linking somewhere that cannot help. */}
                {GAS_FAUCET_URL && (
                  <a role="menuitem" href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" onClick={() => setWalletMenuOpen(false)}>
                    <Fuel size={14} aria-hidden="true" /> Get testnet {GAS_TOKEN}
                  </a>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="wallet-menu-disconnect"
                  onClick={() => {
                    setWalletMenuOpen(false);
                    disconnect();
                  }}
                >
                  <LogOut size={14} aria-hidden="true" /> Disconnect
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-button mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      {wrongNetwork && (
        <div className="wallet-error" role="alert">
          Your wallet is on another network. Tend runs on {CHAIN_LABEL}.
          <button
            type="button"
            className="wallet-error-action"
            onClick={() => switchChain({ chainId: monadTestnet.id })}
            disabled={isSwitching}
          >
            {isSwitching ? "Switching…" : "Switch network"}
          </button>
        </div>
      )}
      {stalled && isConnecting && (
        <div className="wallet-error" role="status">
          Wallet did not respond. Check your wallet extension, or try again.
          <button type="button" onClick={() => setStalled(false)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
      {walletError && (
        <div className="wallet-error" role="alert">
          {walletError}
          <button type="button" onClick={() => setWalletError("")} aria-label="Dismiss wallet error">
            <X size={15} />
          </button>
        </div>
      )}
      {menuOpen && (
        <div className="mobile-nav">
          <span>{NAV_ITEMS.find((item) => item.id === view)?.label}</span>
          <ProductNav
            active={view}
            onChange={(next) => {
              onNavigate(next);
              setMenuOpen(false);
            }}
          />
        </div>
      )}
    </>
  );
}
