"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OtpInput } from "@/components/auth/OtpInput";
import { Modal, CopyField } from "@/components/dashboard/Modal";
import { DepositQrCodes } from "@/components/qr/DepositQrCodes";
import { ApiError } from "@/lib/api";
import { usdcForNetwork, type Address, type Balance } from "@/lib/wallets";
import { explorerTxUrl } from "@/lib/network";
import {
  unlockWallet, getSigningInfo, submitSigned, requestWithdrawOtp, confirmWithdraw,
  getAccountExists, buildSignedPayment, buildSignedChangeTrust, buildSignedCreateAccount,
  txExpiresAt, TX_TIMEOUT_SECONDS, assertNetworkConsistency, validateMemo,
  type SigningInfo, type SubmitResult, type Memo,
} from "@/lib/sdk";
import { parseAmount, formatStroops } from "@/lib/amount";
import { validateStellarAddress, getStellarAddressKind, baseAccountOf } from "@/lib/stellar/address";
import { minimumBalanceStroops, spendableNativeStroops, minCreateAccountStroops, reserveIsExact } from "@/lib/stellar/reserve";
import { friendlyResultMessage, isExpiredResult } from "@/lib/stellar/resultCodes";

export function TrustlineModal({
  token,
  walletId,
  onClose,
  onDone,
}: {
  token: string;
  walletId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    status: string;
    hash: string | null;
    detail: string | null;
  } | null>(null);

  async function submit() {
    setError(null);
    if (!password) {
      setError("Enter your wallet password to sign.");
      return;
    }
    setSubmitting(true);
    try {
      // Unlock the key locally (decrypt with password), build + sign the ChangeTrust in the
      // browser, then relay the signed XDR. The private key never leaves this device.
      const keypair = await unlockWallet(token, walletId, password);
      const info = await getSigningInfo(token, walletId);
      const usdc = usdcForNetwork(info.network_passphrase);
      const signedXdr = buildSignedChangeTrust(keypair, info, {
        asset: { code: usdc.code, issuer: usdc.issuer },
      });
      const res: SubmitResult = await submitSigned(token, walletId, signedXdr);
      setResult({
        status: res.status,
        hash: res.stellar_tx_hash,
        detail: res.detail ?? null,
      });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not add the trustline.";
      setError(message);
      toast.error(message);
    } finally {
      // The password is only needed for the instant of signing; never keep it around.
      setPassword("");
      setSubmitting(false);
    }
  }

  if (result) {
    const ok = result.status === "confirmed";
    return (
      <Modal title="USDC trustline" onClose={onDone}>
        <div className="text-center">
          <p className={`text-3xl ${ok ? "text-burgundy-bright" : "text-warning"}`}>
            {ok ? "✓" : "!"}
          </p>
          <p className="mt-2 font-medium capitalize text-foreground">
            {ok ? "Trustline established" : result.status}
          </p>
          <p className="mt-1 text-sm text-muted">
            {ok
              ? "This wallet can now receive USDC."
              : friendlyResultMessage(
                  result.detail,
                  "The trustline could not be established. Ensure the wallet holds enough XLM for the reserve.",
                )}
          </p>
          {result.hash && (
            <a
              href={explorerTxUrl(result.hash)}
              target="_blank"
              rel="noopener noreferrer"
              title="View transaction on Stellar Explorer"
              className="mt-2 block break-all font-mono text-xs text-burgundy-bright underline decoration-burgundy-bright/40 underline-offset-2 transition-colors hover:decoration-burgundy-bright"
            >
              {result.hash}
            </a>
          )}
          <button
            onClick={onDone}
            className="mt-6 w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add USDC trustline" onClose={onClose}>
      <p className="text-sm text-muted">
        Establishing a trustline lets this master wallet hold and receive{" "}
        <span className="text-foreground">USDC</span> on Stellar. It costs a
        small XLM base reserve and requires signing from your master wallet.
      </p>

      <div className="mt-5 space-y-1 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs">
        <p className="text-muted">
          Asset: <span className="text-foreground">USDC</span>
        </p>
        <p className="text-muted">
          Issuer resolved from your wallet&apos;s network at signing time.
        </p>
      </div>

      <div className="mt-4">
        <label className="text-xs text-muted">Wallet password (to sign)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your encryption password"
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
        />
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-burgundy/40 bg-burgundy/10 px-3 py-2 text-sm text-burgundy-bright">
          {error}
        </p>
      )}

      <button
        onClick={submit}
        disabled={submitting}
        className="mt-5 w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold disabled:opacity-60"
      >
        {submitting ? "Signing…" : "Add trustline"}
      </button>
    </Modal>
  );
}

export function DepositModal({
  addresses,
  baseAddress,
  onClose,
  onNewAddress,
  creating,
}: {
  addresses: Address[];
  baseAddress: string;
  onClose: () => void;
  onNewAddress: () => void;
  creating: boolean;
}) {
  const latest = addresses[0];
  return (
    <Modal title="Deposit" onClose={onClose}>
      <p className="text-sm text-muted">
        Share a deposit address with the sender. Funds sent to it land directly
        in this master wallet and are attributed to the customer.
      </p>

      {latest ? (
        <div className="mt-5 space-y-4">
          <CopyField label="Muxed address (recommended)" value={latest.muxed_address} />
          <CopyField label="Base address (G…+memo fallback)" value={baseAddress} />
          <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs text-muted">
            If the sender can&apos;t use the <code className="text-foreground">M…</code>{" "}
            address, send to the base address with memo (id){" "}
            <span className="text-foreground">{latest.memo_id}</span>.
          </div>
          <DepositQrCodes muxedAddress={latest.muxed_address} baseAddress={baseAddress} memoId={latest.memo_id} />
        </div>
      ) : (
        <div className="mt-5 rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted">
          No addresses yet. Generate one to receive a deposit.
          <button
            onClick={onNewAddress}
            disabled={creating}
            className="mt-3 block w-full rounded-lg glass-btn-primary py-2 text-sm font-semibold disabled:opacity-60"
          >
            {creating ? "Generating…" : "Generate address"}
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Matches the signup OTP cooldown in AuthForm. */
const RESEND_COOLDOWN_SECS = 30;
// Wall clock for event handlers; kept outside components so the purity lint can see it isn't render.
const clockMs = () => Date.now();

/** A withdrawable asset derived from the wallet's balances. */
type WithdrawAsset = {
  code: string; // display code, e.g. "XLM" or "USDC"
  available: string;
  /** undefined => native XLM; otherwise the credit asset to send. */
  asset?: { code: string; issuer: string };
};

/** Stop accepting the code this long before maxTime so the relay can still reach the network. */
const EXPIRY_MARGIN_MS = 10_000;

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function WithdrawModal({
  token,
  walletId,
  walletAddress,
  balances,
  onClose,
  onDone,
}: {
  token: string;
  walletId: string;
  walletAddress?: string;
  balances: Balance[];
  onClose: () => void;
  onDone: () => void;
}) {
  // Build the selectable asset list: XLM first, then any credit asset the
  // wallet holds a trustline for (USDC, etc.).
  const trustlines = balances.filter(
    (b) => b.asset_type !== "native" && b.asset_code && b.asset_issuer,
  );
  const assets: WithdrawAsset[] = [
    {
      code: "XLM",
      available: balances.find((b) => b.asset_type === "native")?.balance ?? "0",
    },
    ...trustlines.map((b) => ({
      code: b.asset_code as string,
      available: b.balance,
      asset: { code: b.asset_code as string, issuer: b.asset_issuer as string },
    })),
  ];

  const defaultAsset: WithdrawAsset = { code: "XLM", available: "0" };
  const [selectedCode, setSelectedCode] = useState((assets[0] ?? defaultAsset).code);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [memoType, setMemoType] = useState<"text" | "id">("text");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  // Once the transaction is signed, it's held here awaiting OTP confirmation before it ever relays.
  const [pendingXdr, setPendingXdr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Reserve/fee params for the spendable-XLM calculation; null until loaded (defaults apply).
  const [reserveInfo, setReserveInfo] = useState<SigningInfo | null>(null);
  // Whether the signed tx creates the destination account (unfunded XLM destination).
  const [createsAccount, setCreatesAccount] = useState(false);
  // Countdown state for the signed envelope's time window.
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [networkExpired, setNetworkExpired] = useState(false);
  const [resigning, setResigning] = useState(false);
  // OTP resend cooldown for the already-signed tx.
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resending, setResending] = useState(false);
  const resendCooldown = Math.max(0, Math.ceil((resendAvailableAt - now) / 1000));

  const selected =
    assets.find((a) => a.code === selectedCode) ?? assets[0] ?? defaultAsset;

  useEffect(() => {
    getSigningInfo(token, walletId).then(setReserveInfo).catch(() => {});
  }, [token, walletId]);

  // Tick once a second while a signed transaction is waiting for its code.
  useEffect(() => {
    if (expiresAt === null && !pendingXdr) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt, pendingXdr]);

  const secondsLeft =
    expiresAt === null
      ? 0
      : Math.max(0, Math.floor((expiresAt - EXPIRY_MARGIN_MS - now) / 1000));
  const expired = networkExpired || (expiresAt !== null && secondsLeft <= 0);

  const availableStroops = (() => {
    const p = parseAmount(selected.available);
    return p.ok ? p.stroops : BigInt(0);
  })();
  const spendableStroops = selected.asset
    ? availableStroops
    : spendableNativeStroops(availableStroops, reserveInfo, trustlines.length);
  const reserveStroops = selected.asset
    ? null
    : minimumBalanceStroops(reserveInfo, trustlines.length);

  // Everything checkable without the password, so bad input never reaches the unlock/sign step.
  function validate(): { error: string } | { stroops: bigint } {
    const addrError = validateStellarAddress(destination, { ownAddress: walletAddress });
    if (addrError) return { error: addrError };
    const parsed = parseAmount(amount);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.stroops <= BigInt(0)) return { error: "Enter an amount greater than 0." };
    if (parsed.stroops > spendableStroops) {
      return {
        error: selected.asset
          ? `You can send at most ${formatStroops(spendableStroops)} ${selected.code}.`
          : `You can send at most ${formatStroops(spendableStroops)} XLM — the rest covers Stellar's minimum reserve and the network fee.`,
      };
    }
    const memoValue = memo.trim();
    if (memoValue) {
      const memoError = validateMemo(memoType === "id" ? { type: "id", id: memoValue } : { type: "text", text: memoValue });
      if (memoError) return { error: memoError };
    }
    return { stroops: parsed.stroops };
  }

  async function requestOtp() {
    setError(null);
    const checked = validate();
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    if (!password) {
      setError("Enter your wallet password to sign.");
      return;
    }
    setSubmitting(true);
    try {
      // Unfunded destinations can't receive a plain payment (op_no_destination); null = unknown.
      const exists = await getAccountExists(token, walletId, baseAccountOf(destination))
        .then((r) => r.exists)
        .catch(() => null);
      const needsCreate = exists === false;
      if (needsCreate && selected.asset) {
        setError(
          `This address isn't activated on Stellar yet, so it can't hold ${selected.code}. Ask the recipient to fund it with XLM and add a ${selected.code} trustline first.`,
        );
        return;
      }
      if (needsCreate && getStellarAddressKind(destination) === "med25519") {
        setError(
          "This muxed (M…) address belongs to an account that isn't activated yet. Send at least 1 XLM to its base G… address first.",
        );
        return;
      }
      if (needsCreate && checked.stroops < minCreateAccountStroops(reserveInfo)) {
        setError(
          `This address isn't activated on Stellar yet. Send at least ${formatStroops(minCreateAccountStroops(reserveInfo))} XLM to create it.`,
        );
        return;
      }

      // Unlock and sign locally — the private key never leaves this device. Only after signing
      // do we ask the server to email an OTP bound to this exact transaction.
      const keypair = await unlockWallet(token, walletId, password, walletAddress);
      const info = await getSigningInfo(token, walletId);
      assertNetworkConsistency(info.network_passphrase);
      const memoValue = memo.trim();
      const memoPayload: Memo | undefined = memoValue
        ? memoType === "id"
          ? { type: "id", id: memoValue }
          : { type: "text", text: memoValue }
        : undefined;
      const normalized = formatStroops(checked.stroops);
      const signedXdr = needsCreate
        ? buildSignedCreateAccount(keypair, info, {
            destination,
            startingBalance: normalized,
            memo: memoPayload,
          })
        : buildSignedPayment(keypair, info, {
            destination,
            amount: normalized,
            asset: selected.asset, // undefined => XLM
            memo: memoPayload,
          });
      await requestWithdrawOtp(token, walletId, signedXdr);
      setCreatesAccount(needsCreate);
      setReserveInfo(info);
      const signedAt = clockMs();
      setNow(signedAt);
      setExpiresAt(txExpiresAt(signedXdr, info.network_passphrase));
      setNetworkExpired(false);
      setResigning(false);
      setResendAvailableAt(signedAt + RESEND_COOLDOWN_SECS * 1000);
      setPendingXdr(signedXdr);
    } catch (err) {
      const message = friendlyResultMessage(
        err instanceof Error ? err.message : null,
        "Withdrawal failed.",
      );
      setError(message);
      toast.error(message);
    } finally {
      // The password is only needed for the instant of signing; never keep it around.
      setPassword("");
      setSubmitting(false);
    }
  }

  // Re-sends the OTP for the already-signed tx, so the user doesn't have to unlock and sign again.
  async function resendOtp() {
    if (!pendingXdr || resending || resendCooldown > 0 || expired) return;
    setError(null);
    setResending(true);
    try {
      await requestWithdrawOtp(token, walletId, pendingXdr);
      setResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECS * 1000);
      setNow(Date.now());
      toast.success("A new code is on its way.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not resend the code.";
      setError(message);
      toast.error(message);
    } finally {
      setResending(false);
    }
  }

  async function confirm() {
    if (!pendingXdr) return;
    setError(null);
    if (expired) return;
    if (code.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await confirmWithdraw(token, walletId, pendingXdr, code);
      if (res.status !== "confirmed" && isExpiredResult(res.detail)) {
        setNetworkExpired(true);
        return;
      }
      setResult(res);
      if (res.status !== "confirmed") {
        toast.error(friendlyResultMessage(res.detail, "The withdrawal was not confirmed."));
      }
    } catch (err) {
      const raw = err instanceof ApiError ? err.message : null;
      if (isExpiredResult(raw)) {
        setNetworkExpired(true);
        return;
      }
      const message = friendlyResultMessage(raw, "Invalid or expired code.");
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Drop the signed envelope and return to the form, keeping destination + amount.
  function discardSigned(resign: boolean) {
    setPendingXdr(null);
    setExpiresAt(null);
    setNetworkExpired(false);
    setCode("");
    setError(null);
    setResigning(resign);
  }

  if (result) {
    const ok = result.status === "confirmed";
    const finish = () => onDone();
    return (
      <Modal title="Withdrawal" onClose={finish}>
        <div className="text-center">
          <p className={`text-3xl ${ok ? "text-burgundy-bright" : "text-warning"}`}>
            {ok ? "✓" : "!"}
          </p>
          <p className="mt-2 font-medium capitalize text-foreground">
            {result.status}
          </p>
          {!ok && (
            <p className="mt-1 text-sm text-muted">
              {friendlyResultMessage(result.detail, "The withdrawal could not be completed.")}
            </p>
          )}
          {result.stellar_tx_hash && (
            <a
              href={explorerTxUrl(result.stellar_tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              title="View transaction on Stellar Explorer"
              className="mt-2 block break-all font-mono text-xs text-burgundy-bright underline decoration-burgundy-bright/40 underline-offset-2 transition-colors hover:decoration-burgundy-bright"
            >
              {result.stellar_tx_hash}
            </a>
          )}
          <button
            onClick={finish}
            className="mt-6 w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  if (pendingXdr && expired) {
    return (
      <Modal title="Withdrawal expired" onClose={onClose}>
        <div className="text-center">
          <p className="text-3xl text-warning">!</p>
          <p className="mt-2 text-sm text-muted">
            For your security, a signed withdrawal is only valid for{" "}
            {Math.round(TX_TIMEOUT_SECONDS / 60)} minutes, and this one ran out before
            the code was confirmed. <span className="text-foreground">Nothing was sent.</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            Sign again with your password and we&apos;ll email you a new code.
          </p>
          <button
            onClick={() => discardSigned(true)}
            className="mt-6 w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold"
          >
            Sign again
          </button>
        </div>
      </Modal>
    );
  }

  if (pendingXdr) {
    return (
      <Modal title="Verify withdrawal" onClose={onClose}>
        <p className="text-center text-sm text-muted">
          Enter the 6-digit code we emailed you to confirm this withdrawal of{" "}
          <span className="text-foreground">
            {amount} {selected.code}
          </span>
          .
        </p>
        {memo.trim() && (
          <p className="mt-1 text-center text-xs text-muted">
            Memo: {memoType === "id" ? "ID " : "Text "}{memo.trim()}
          </p>
        )}
        {createsAccount && (
          <p className="mt-2 text-center text-xs text-muted">
            This address isn&apos;t activated yet — this withdrawal will create it.
          </p>
        )}

        <p
          className={`mt-3 text-center text-xs ${secondsLeft <= 30 ? "text-warning" : "text-muted"}`}
          aria-live="polite"
        >
          Expires in{" "}
          <span className="font-mono text-foreground">{formatCountdown(secondsLeft)}</span>
        </p>

        <div className="mt-4">
          <OtpInput value={code} onChange={setCode} disabled={submitting} />
        </div>

        {expired && (
          <p className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            This signed withdrawal has expired. Go back and sign it again to get a new code.
          </p>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-burgundy/40 bg-burgundy/10 px-3 py-2 text-sm text-burgundy-bright">
            {error}
          </p>
        )}

        <button
          onClick={confirm}
          disabled={submitting || expired}
          className="mt-5 w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {submitting ? "Confirming…" : "Verify & withdraw"}
        </button>
        {!expired && (
          <p className="mt-4 text-center text-xs text-muted">
            Didn&apos;t get a code?{" "}
            <button
              type="button"
              onClick={resendOtp}
              disabled={resending || resendCooldown > 0}
              className="font-semibold text-foreground hover:text-burgundy-bright disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resending
                ? "Sending…"
                : resendCooldown > 0
                  ? `Resend in ${resendCooldown}s`
                  : "Resend code"}
            </button>
          </p>
        )}
        <button
          onClick={() => discardSigned(false)}
          className="mt-3 w-full text-center text-xs text-muted hover:text-foreground"
        >
          Back
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Withdraw" onClose={onClose}>
      <p className="text-sm text-muted">
        Send {selected.code} from this master wallet. Available:{" "}
        <span className="text-foreground">
          {selected.available} {selected.code}
        </span>
        .
      </p>
      {reserveStroops !== null && (
        <p className="mt-1 text-xs text-muted">
          Spendable:{" "}
          <span className="text-foreground">{formatStroops(spendableStroops)} XLM</span>{" "}
          ({reserveIsExact(reserveInfo) ? "" : "about "}
          {formatStroops(reserveStroops)} XLM stays as Stellar&apos;s minimum reserve, plus the
          network fee).
        </p>
      )}

      {resigning && (
        <p className="mt-4 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs text-muted">
          Your previous signature expired. Re-enter your password to sign a fresh withdrawal —
          we&apos;ll email a new code.
        </p>
      )}

      <div className="mt-5 space-y-4">
        <div>
          <label className="text-xs text-muted">Asset</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {assets.map((a) => (
              <button
                key={a.code}
                type="button"
                onClick={() => setSelectedCode(a.code)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  a.code === selectedCode
                    ? "border-burgundy-bright bg-burgundy/20 text-foreground"
                    : "border-border bg-surface-sunken text-muted hover:border-border-strong"
                }`}
              >
                {a.code}
              </button>
            ))}
          </div>
          {assets.length === 1 && (
            <p className="mt-1.5 text-[11px] text-muted">
              Add a USDC trustline to withdraw USDC.
            </p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted">Destination address</label>
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value.trim())}
            placeholder="G… or M…"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted">Amount ({selected.code})</label>
            <button
              type="button"
              onClick={() => setAmount(formatStroops(spendableStroops))}
              disabled={spendableStroops <= BigInt(0)}
              className="text-xs text-burgundy-bright hover:underline disabled:opacity-50"
            >
              Max
            </button>
          </div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.0000000"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted">Memo (optional)</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setMemoType("text")}
                className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                  memoType === "text"
                    ? "border-burgundy-bright bg-burgundy/20 text-foreground"
                    : "border-border bg-surface-sunken text-muted hover:border-border-strong"
                }`}
              >
                Text
              </button>
              <button
                type="button"
                onClick={() => setMemoType("id")}
                className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                  memoType === "id"
                    ? "border-burgundy-bright bg-burgundy/20 text-foreground"
                    : "border-border bg-surface-sunken text-muted hover:border-border-strong"
                }`}
              >
                ID
              </button>
            </div>
          </div>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value.trim())}
            placeholder={memoType === "text" ? "e.g. Invoice 123" : "e.g. 12345"}
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-muted">
            {memoType === "text"
              ? "Text memos are limited to 28 characters."
              : "Numeric memo ID (up to 64 bits). Exchanges/custodians may require this to credit deposits."}
          </p>
        </div>
        <div>
          <label className="text-xs text-muted">Wallet password (to sign)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your encryption password"
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-muted">
            Signs locally on this device — your key never leaves the browser. After signing you
            have {Math.round(TX_TIMEOUT_SECONDS / 60)} minutes to enter the emailed code.
          </p>
        </div>

        {error && (
          <p className="rounded-lg border border-burgundy/40 bg-burgundy/10 px-3 py-2 text-sm text-burgundy-bright">
            {error}
          </p>
        )}

        <button
          onClick={requestOtp}
          disabled={submitting}
          className="w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {submitting ? "Signing…" : resigning ? "Sign again" : "Withdraw"}
        </button>
      </div>
    </Modal>
  );
}

// Stat / ActionButton / Panel / Empty moved to @/components/dashboard/WalletUI so every wallet
// sub-page (Overview, Assets, ...) shares the same building blocks.
