"use client";

import { use, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { CopyButton } from "@/components/CopyButton";
import { AddressQrCode } from "@/components/qr/AddressQrCode";
import { sep7PayUri } from "@/lib/sep7";
import {
  getPublicPaymentLink,
  createPaymentIntent,
  getPaymentStatus,
  getPublicSigningInfo,
  submitPublicPayment,
  usdAmountToStroops,
  isValidEmail,
  type PublicPaymentLink,
  type PaymentIntent,
  type PaymentStatus,
} from "@/lib/payment-links";
import { usdcForNetwork } from "@/lib/networkConfig";
import { network } from "@/lib/network";
import { buildUnsignedPayment, assertNetworkConsistency } from "@/lib/sdk";
import { OctoSpinner } from "@/components/OctoSpinner";
import { PayerPrivacyNotice } from "@/components/checkout/PayerPrivacyNotice";
import confetti from "canvas-confetti";
import { formatStroops } from "@/lib/amount";
import { friendlyResultMessage } from "@/lib/stellar/resultCodes";
import { isTrustedImageUrl } from "@/lib/isTrustedImageUrl";
import { validateRedirectUrl } from "@/lib/redirectUrl";

type Step = "loading" | "not-found" | "form" | "pay" | "confirmed";

/** Keep the loading spinner up for at least this long so it doesn't just flash on fast loads. */
const MIN_LOADING_MS = 700;

/** Stop auto-polling after this long when the API doesn't tell us when the intent expires. */
const MAX_POLL_MS = 30 * 60_000;

/** Warn the payer once this much time is left before the intent expires. */
const EXPIRY_WARNING_MS = 2 * 60_000;

// Status poll interval, backing off 3s → 5s → 10s the longer the payer waits.
function pollDelayMs(elapsedMs: number) {
  if (elapsedMs < 60_000) return 3_000;
  if (elapsedMs < 3 * 60_000) return 5_000;
  return 10_000;
}

// Identifies the payer inputs an intent was created from, so edits force a fresh intent.
function intentInputsKey(amountUsdcStroops: number, name: string, email: string) {
  return JSON.stringify([amountUsdcStroops, name, email.toLowerCase()]);
}

// Formats a millisecond countdown as m:ss (or h:mm:ss past an hour) for the payer.
function formatCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function celebrate() {
  confetti({ 
    particleCount: 140, 
    spread: 80, 
    origin: { y: 0.6 },
    disableForReducedMotion: true 
  });
}

// Sends the payer back to the merchant's site after a short delay; fails closed on a bad URL.
function redirectAfterConfirm(redirectUrl: string, paymentId: string, slugValue: string) {
  const error = validateRedirectUrl(redirectUrl);
  if (error) {
    // malformed or unsafe redirect_url — stay on the confirmed page instead of redirecting
    return;
  }
  try {
    const url = new URL(redirectUrl);
    url.searchParams.set("status", "success");
    url.searchParams.set("payment_id", paymentId);
    url.searchParams.set("slug", slugValue);
    setTimeout(() => {
      window.location.href = url.toString();
    }, 2000);
  } catch {
    // malformed redirect_url — stay on the confirmed page
  }
}

export default function PayPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);

  const [step, setStep] = useState<Step>("loading");
  const [link, setLink] = useState<PublicPaymentLink | null>(null);
  const [amount, setAmount] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [freighterBusy, setFreighterBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  // Set only for a resolved-but-not-successful status (expired/underpaid/overpaid).
  const [resolvedStatus, setResolvedStatus] = useState<PaymentStatus | null>(null);
  // True once auto-polling gave up without a known expiry; "check now" still works.
  const [pollStopped, setPollStopped] = useState(false);
  // Live intent plus the inputs/time it was created from, readable from async callbacks.
  const intentRef = useRef<{ intent: PaymentIntent; key: string; createdAt: number } | null>(null);
  // Guards confirmation side-effects (confetti, redirect) so they run exactly once.
  const confirmedRef = useRef(false);
  // Network passphrase received from signing-info; used to resolve the correct USDC issuer.
  const [networkPassphrase, setNetworkPassphrase] = useState<string>("");
  // Ticking clock driving the expiry countdown; null until an intent with an expiry exists.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = Date.now();
    const finish = (next: Step) => {
      const remaining = MIN_LOADING_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        setTimeout(() => setStep(next), remaining);
      } else {
        setStep(next);
      }
    };
    getPublicPaymentLink(slug)
      .then((l) => {
        setLink(l);
        if (l.amount_usdc_stroops !== null) {
          setAmount(formatStroops(l.amount_usdc_stroops));
        }
        finish("form");
      })
      .catch(() => finish("not-found"));
  }, [slug]);

  // Swaps the active intent, resetting everything that belonged to the previous one.
  function replaceIntent(next: PaymentIntent | null, key = "") {
    intentRef.current = next ? { intent: next, key, createdAt: Date.now() } : null;
    setIntent(next);
    setResolvedStatus(null);
    setPollStopped(false);
    setCheckMessage(null);
    // Restart the countdown clock for the new intent (or clear it when there is none).
    setNow(next?.expires_at ? Date.now() : null);
  }

  // The single path for every confirmation source (poll, check-now, Freighter).
  function markConfirmed(paymentId: string) {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    setStep("confirmed");
    celebrate();
    if (link?.redirect_url) {
      redirectAfterConfirm(link.redirect_url, paymentId, slug);
    }
  }

  // Handles a status response for `paymentId`; returns true once resolved. Stale intents are ignored.
  function applyStatus(paymentId: string, status: PaymentStatus): boolean {
    if (intentRef.current?.intent.payment_id !== paymentId || confirmedRef.current) return true;
    if (status.status === "confirmed") {
      markConfirmed(paymentId);
      return true;
    }
    if (status.status === "expired" || status.status === "underpaid" || status.status === "overpaid") {
      setResolvedStatus(status);
      return true;
    }
    return false;
  }

  // Expiry is derived from the intent's expires_at so the UI can't drift from the backend.
  const expiresAtMs = intent?.expires_at ? Date.parse(intent.expires_at) : NaN;
  const hasExpiry = Number.isFinite(expiresAtMs);
  const hasNow = now !== null;
  const remainingMs = hasExpiry && hasNow ? expiresAtMs - now : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;

  // Ticks once a second while a countdown is active; stops itself once the intent is gone.
  useEffect(() => {
    if (!hasExpiry || !hasNow || isExpired) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasExpiry, hasNow, isExpired]);

  // Polls for confirmation with backoff; pauses while hidden or a Freighter submit is in flight.
  useEffect(() => {
    if (!intent || step !== "pay" || resolvedStatus || pollStopped || freighterBusy) return;
    const paymentId = intent.payment_id;
    const createdAt = intentRef.current?.createdAt ?? Date.now();
    const expiresAt = intent.expires_at ? Date.parse(intent.expires_at) : NaN;
    const hasExpiry = Number.isFinite(expiresAt);
    const stopAt = hasExpiry ? expiresAt : createdAt + MAX_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let cancelled = false;

    const hidden = () => document.visibilityState === "hidden";

    // Past the window: show the expired state if the API gave an expiry, otherwise just stop.
    const finish = () => {
      if (hasExpiry) {
        setResolvedStatus({
          status: "expired",
          transaction_id: null,
          expected_usdc_stroops: intent.amount_usdc_stroops,
          received_usdc_stroops: null,
        });
      } else {
        setPollStopped(true);
      }
    };

    const schedule = () => {
      if (cancelled || hidden()) return;
      const now = Date.now();
      const delay = Math.min(pollDelayMs(now - createdAt), Math.max(0, stopAt - now));
      timer = setTimeout(tick, delay);
    };

    // One status check, then schedule the next; the final check happens at/after the stop time.
    async function tick() {
      timer = undefined;
      if (cancelled || hidden() || inFlight) return;
      inFlight = true;
      try {
        const status = await getPaymentStatus(slug, paymentId);
        if (cancelled || applyStatus(paymentId, status)) return;
      } catch {
        // transient — keep polling
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      if (Date.now() >= stopAt) return finish();
      schedule();
    }

    // Hidden: drop the pending timer. Visible again: check immediately, then resume the schedule.
    const onVisibility = () => {
      if (hidden()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!timer && !inFlight) {
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, step, slug, link, resolvedStatus, pollStopped, freighterBusy]);

  // Flips the UI to the expired state the moment the countdown hits zero.
  useEffect(() => {
    if (!intent || step !== "pay" || resolvedStatus || !isExpired) return;
    setResolvedStatus({
      status: "expired",
      transaction_id: null,
      expected_usdc_stroops: intent.amount_usdc_stroops,
      received_usdc_stroops: null,
    });
  }, [intent, step, resolvedStatus, isExpired]);

  async function handleCheckPayment() {
    if (!intent) return;
    const paymentId = intent.payment_id;
    setChecking(true);
    setCheckMessage(null);
    try {
      const status = await getPaymentStatus(slug, paymentId);
      if (!applyStatus(paymentId, status)) {
        setCheckMessage(
          "Not received yet — deposits can take a little while to be detected. This page will update automatically once it lands.",
        );
      }
    } catch {
      setCheckMessage("Could not check payment status. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!link) return;
    setSubmitting(true);
    setError(null);
    try {
      // Name and email are required — a payer's identity must be collectible before they pay.
      if (!payerName.trim() || !payerEmail.trim()) {
        setError("Enter your name and email address.");
        setSubmitting(false);
        return;
      }
      if (!isValidEmail(payerEmail.trim())) {
        setError("Enter a valid email address.");
        setSubmitting(false);
        return;
      }
      const amountUsdcStroops =
        link.amount_usdc_stroops ?? usdAmountToStroops(amount);
      if (amountUsdcStroops === null) {
        setError("Enter a valid amount.");
        setSubmitting(false);
        return;
      }
      // Reuse the intent only if nothing changed; otherwise the deposit address would carry a stale amount.
      const key = intentInputsKey(amountUsdcStroops, payerName.trim(), payerEmail.trim());
      if (intentRef.current && intentRef.current.key === key) {
        setStep("pay");
        return;
      }
      replaceIntent(null);
      const created = await createPaymentIntent(slug, {
        payerName: payerName.trim() || undefined,
        payerEmail: payerEmail.trim() || undefined,
        amountUsdcStroops,
      });
      replaceIntent(created, key);
      setStep("pay");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start this payment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFreighterPay() {
    if (!intent) return;
    // Never start a wallet flow against an intent that has already expired.
    if (isExpired) return;
    setFreighterBusy(true);
    setError(null);
    try {
      const freighter = await import("@stellar/freighter-api");
      const access = await freighter.requestAccess();
      if (access.error || !access.address) {
        throw new Error("Could not connect to Freighter. Is it installed and unlocked?");
      }

      // Sequence must be the PAYER's own (it's the tx source), not the merchant's.
      const info = await getPublicSigningInfo(slug, access.address);
      assertNetworkConsistency(info.network_passphrase);
      setNetworkPassphrase(info.network_passphrase);
      const usdc = usdcForNetwork(info.network_passphrase);

      // Verify Freighter is on the same network before touching the transaction.
      const networkDetails = await freighter.getNetworkDetails();
      if (networkDetails.error || networkDetails.networkPassphrase !== info.network_passphrase) {
        const expected = info.network_passphrase.includes("Public")
          ? "Stellar Mainnet"
          : "Stellar Testnet";
        throw new Error(`Switch Freighter to ${expected} and try again.`);
      }
      const unsignedXdr = buildUnsignedPayment(access.address, info, {
        destination: intent.deposit_address,
        amount: formatStroops(intent.amount_usdc_stroops),
        asset: usdc,
      });

      const signed = await freighter.signTransaction(unsignedXdr, {
        networkPassphrase: info.network_passphrase,
        address: access.address,
      });
      if (signed.error || !signed.signedTxXdr) {
        throw new Error("Freighter did not return a signed transaction.");
      }

      const result = await submitPublicPayment(slug, signed.signedTxXdr, intent.payment_id);
      if (result.status === "confirmed") {
        markConfirmed(intent.payment_id);
        return;
      }
      throw new Error(
        friendlyResultMessage(result.detail, "The payment could not be confirmed on-chain."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Freighter payment failed.");
    } finally {
      setFreighterBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 md:grid-cols-2">
        <div className="flex flex-col justify-between bg-black p-8">
          <div className="flex items-center justify-between">
            <Logo />
            {/* Badge is only shown on testnet — on mainnet payers must not see a "Testnet" label. */}
            {network.isTestnet && (
              <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                {network.displayName}
              </span>
            )}
          </div>

          {link && (
            <div className="mt-10">
              <p className="text-sm text-muted">Pay {link.name}</p>
              <p className="mt-2 text-4xl font-semibold text-foreground">
                {link.amount_usdc_stroops !== null
                  ? `$${formatStroops(link.amount_usdc_stroops)}`
                  : step !== "form" && intent
                    ? `$${formatStroops(intent.amount_usdc_stroops)}`
                    : amount
                    ? `$${amount}`
                    : "$—"}
              </p>
              {link.description && (
                <p className="mt-3 text-sm text-muted">{link.description}</p>
              )}
            </div>
          )}

          {link?.image_url && isTrustedImageUrl(link.image_url) ? (
            <img
              src={link.image_url}
              alt=""
              className="mt-8 aspect-square w-full rounded-2xl object-cover"
            />
          ) : (
            <div className="mt-8 flex aspect-square w-full items-center justify-center rounded-2xl bg-burgundy/10">
              <Logo className="scale-150 opacity-40" />
            </div>
          )}
        </div>

        <div className="bg-white p-8">
          {step === "loading" && (
            <div className="flex h-full items-center justify-center py-12">
              <OctoSpinner size={40} />
            </div>
          )}

          {step === "not-found" && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-lg font-semibold text-gray-900">Link not found</p>
                <p className="mt-2 text-sm text-gray-500">
                  This payment link doesn&apos;t exist or is no longer active.
                </p>
              </div>
            </div>
          )}

          {step === "form" && link && (
            <form onSubmit={handleContinue} className="space-y-5">
              <StepHeader current="Personal Information" />

              {link.amount_usdc_stroops === null && (
                <Field label="Enter Amount" htmlFor="payer-amount">
                  <input
                    id="payer-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                  />
                </Field>
              )}

              <Field label="Enter Personal Information" htmlFor="payer-name">
                <div className="space-y-2">
                  <input
                    id="payer-name"
                    value={payerName}
                    onChange={(e) => setPayerName(e.target.value)}
                    placeholder="Full name"
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                  />
                  <input
                    value={payerEmail}
                    onChange={(e) => setPayerEmail(e.target.value)}
                    placeholder="Email address"
                    aria-label="Email address"
                    type="email"
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-black"
                  />
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  We use this to send you a confirmation of your payment.
                </p>
                <PayerPrivacyNotice merchantName={link.name} />
              </Field>

              {error && <ErrorBanner message={error} />}

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-black py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting && <OctoSpinner size={16} className="text-white" />}
                {submitting ? "Please wait…" : "Continue"}
              </button>
              <p className="text-center text-[11px] text-gray-400">
                🔒 Secure and encrypted payment.
              </p>
            </form>
          )}

          {step === "pay" && intent && resolvedStatus && (
            <MismatchBanner
              status={resolvedStatus}
              onBack={() => {
                // The old intent is permanently resolved — starting over needs a fresh one.
                replaceIntent(null);
                setStep("form");
              }}
            />
          )}

          {step === "pay" && intent && !resolvedStatus && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <StepHeader current="Payment Method" />
                {/* Locked mid-Freighter so the payer can't swap intents under an in-flight tx. */}
                <button
                  type="button"
                  onClick={() => setStep("form")}
                  disabled={freighterBusy}
                  className="text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
                >
                  ‹ Back
                </button>
              </div>

              {remainingMs !== null && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    remainingMs <= EXPIRY_WARNING_MS
                      ? "border-amber-300 bg-amber-50 text-amber-700"
                      : "border-gray-200 bg-gray-50 text-gray-600"
                  }`}
                >
                  {remainingMs <= EXPIRY_WARNING_MS
                    ? `⚠️ Less than ${formatCountdown(remainingMs)} left — complete your payment now or it will expire.`
                    : `⏳ Time remaining to pay: ${formatCountdown(remainingMs)}`}
                </div>
              )}

              <div className="rounded-lg border border-gray-200 p-4">
                <p className="text-xs text-gray-500">Amount</p>
                <p className="mt-1 text-sm font-medium text-gray-900">
                  ${formatStroops(intent.amount_usdc_stroops)}
                </p>
              </div>

              {/* Deposit address and QR are hidden once expired so nothing can be sent to a dead intent. */}
              {!isExpired && (
              <div>
                <p className="text-sm font-medium text-gray-900">Wallet Transfer</p>
                <p className="mt-1 text-[11px] text-gray-500">
                  Send USDC from any Stellar wallet to the address below.
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2">
                  <span className="flex-1 truncate font-mono text-xs text-gray-900">
                    {intent.deposit_address}
                  </span>
                  <CopyButton
                    value={intent.deposit_address}
                    className="text-xs text-gray-500 hover:text-gray-900"
                  />
                </div>
                <div className="mt-3 flex justify-center">
                  <AddressQrCode
                    value={sep7PayUri({
                      destination: intent.deposit_address,
                      amount: formatStroops(intent.amount_usdc_stroops),
                      assetCode: usdcForNetwork(networkPassphrase).code,
                      assetIssuer: usdcForNetwork(networkPassphrase).issuer,
                    })}
                    label="Scan with a Stellar wallet to pay the exact amount"
                  />
                </div>
                <p className="mt-2 text-[11px] text-gray-500">
                  Some exchanges don&apos;t support M… addresses; pay from a self-custody wallet.
                </p>
                <button
                  type="button"
                  onClick={handleCheckPayment}
                  disabled={checking}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2 text-xs font-medium text-gray-900 transition-colors hover:border-black disabled:opacity-50"
                >
                  {checking && <OctoSpinner size={14} />}
                  {checking ? "Checking…" : "I've sent the payment — check now"}
                </button>
                {checkMessage && (
                  <p className="mt-2 text-[11px] text-gray-500">{checkMessage}</p>
                )}
              </div>
              )}

              {!isExpired && (
              <div className="flex items-center gap-3 text-[11px] text-gray-400">
                <div className="h-px flex-1 bg-gray-200" />
                OR
                <div className="h-px flex-1 bg-gray-200" />
              </div>
              )}

              {!isExpired && (
              <div>
                <p className="text-sm font-medium text-gray-900">Connect Wallet</p>
                <button
                  type="button"
                  onClick={handleFreighterPay}
                  disabled={freighterBusy}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:border-black disabled:opacity-50"
                >
                  {freighterBusy && <OctoSpinner size={16} />}
                  {freighterBusy ? "Connecting…" : "🦄 Connect Freighter"}
                </button>
              </div>
              )}

              {error && <ErrorBanner message={error} />}

              <p className="text-center text-[11px] text-gray-400">
                {pollStopped
                  ? "Stopped checking automatically — use “check now” once you've sent the payment."
                  : "Waiting for payment — this page updates automatically once it's received."}
              </p>
            </div>
          )}

          {step === "confirmed" && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <p className="text-3xl">✅</p>
              <p className="mt-3 text-lg font-semibold text-gray-900">Payment received</p>
              <p className="mt-2 text-sm text-gray-500">
                Thank you{payerName ? `, ${payerName}` : ""} — your payment has been
                confirmed on-chain.
              </p>
              {link?.redirect_url && (
                <p className="mt-4 text-[11px] text-gray-400">Redirecting you back…</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepHeader({ current }: { current: "Personal Information" | "Payment Method" }) {
  const steps = ["Personal Information", "Payment Method"] as const;
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
              s === current
                ? "bg-black text-white"
                : steps.indexOf(current) > i
                  ? "bg-gray-900 text-white"
                  : "bg-gray-200 text-gray-500"
            }`}
          >
            {i + 1}
          </span>
          <span className={s === current ? "font-medium text-gray-900" : "text-gray-400"}>
            {s}
          </span>
          {i === 0 && <span className="mx-1 h-px w-8 bg-gray-200" />}
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-sm font-medium text-gray-900">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function MismatchBanner({
  status,
  onBack,
}: {
  status: PaymentStatus;
  onBack: () => void;
}) {
  const copy = {
    expired: {
      title: "Payment window expired",
      body: "This payment wasn't completed in time. Go back and start again.",
    },
    underpaid: {
      title: "Amount too low",
      body: `You sent $${formatStroops(status.received_usdc_stroops ?? 0)}, but $${formatStroops(status.expected_usdc_stroops)} was expected. Contact the merchant to resolve this.`,
    },
    overpaid: {
      title: "Amount too high",
      body: `You sent $${formatStroops(status.received_usdc_stroops ?? 0)}, but only $${formatStroops(status.expected_usdc_stroops)} was expected. Contact the merchant to resolve this.`,
    },
  }[status.status as "expired" | "underpaid" | "overpaid"];

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-3xl">⚠️</p>
      <p className="mt-3 text-lg font-semibold text-gray-900">{copy.title}</p>
      <p className="mt-2 max-w-xs text-sm text-gray-500">{copy.body}</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-5 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 hover:border-black"
      >
        ‹ Back
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
      {message}
    </p>
  );
}
