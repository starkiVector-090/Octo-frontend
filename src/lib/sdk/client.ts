/**
 * API calls for the non-custodial flow: fetch signing info, submit a signed tx, fetch/store the
 * encrypted backup. Thin wrappers over `apiFetch`, kept in the SDK so an external customer could
 * use the same module.
 */
import { apiFetch, path } from "@/lib/api";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-base";
import { network } from "@/lib/network";
import { baseAccountOf } from "@/lib/stellar/address";
import type { SigningInfo } from "./tx";

/** Refuse to relay unless the source account's signature verifies under the configured network. */
function guardNetwork(signedXdr: string) {
  const decoded = TransactionBuilder.fromXDR(signedXdr, network.passphrase);
  const tx = decoded instanceof Transaction ? decoded : decoded.innerTransaction;
  const signer = Keypair.fromPublicKey(baseAccountOf(tx.source));
  const hash = tx.hash();
  if (!tx.signatures.some((sig) => signer.verify(hash, sig.signature()))) {
    throw new Error(
      `Refusing to relay: this transaction was not signed for the ${network.displayName} network.`,
    );
  }
}

export type SubmitResult = {
  status: string;
  stellar_tx_hash: string | null;
  detail?: string | null;
};

/**
 * Fetch what the client needs to build a transaction (sequence + network params).
 *
 * `base_fee_stroops` is validated client-side by the transaction builders before use; callers
 * receive the validated fee for display.
 */
export function getSigningInfo(token: string, walletId: string) {
  return apiFetch<SigningInfo>(path`/v1/wallets/${walletId}/signing-info`, { token });
}

/** Relay a client-signed transaction. The server validates + submits; it never signs. */
export function submitSigned(token: string, walletId: string, signedXdr: string) {
  guardNetwork(signedXdr);
  return apiFetch<SubmitResult>(path`/v1/wallets/${walletId}/submit-signed`, {
    method: "POST",
    token,
    body: JSON.stringify({ transaction_xdr: signedXdr }),
  });
}

/** Email an OTP bound to this exact signed transaction, ahead of a withdrawal relay. */
export function requestWithdrawOtp(token: string, walletId: string, signedXdr: string) {
  guardNetwork(signedXdr);
  return apiFetch<{ sent: boolean }>(path`/v1/wallets/${walletId}/withdraw/request-otp`, {
    method: "POST",
    token,
    body: JSON.stringify({ transaction_xdr: signedXdr }),
  });
}

/** Confirm the withdrawal OTP; only on success does the transaction actually relay to Horizon. */
export function confirmWithdraw(
  token: string,
  walletId: string,
  signedXdr: string,
  code: string,
) {
  guardNetwork(signedXdr);
  return apiFetch<SubmitResult>(path`/v1/wallets/${walletId}/withdraw/confirm`, {
    method: "POST",
    token,
    body: JSON.stringify({ transaction_xdr: signedXdr, code }),
  });
}

/** Fetch the opaque encrypted backup blob for new-device recovery (may be null). */
export function getBackup(token: string, walletId: string) {
  return apiFetch<{
    wallet_id: string;
    encrypted_backup: string | null;
    /** Server-assigned version of the backup copy, when the backend reports one. */
    backup_version?: string | null;
  }>(path`/v1/wallets/${walletId}/backup`, { token });
}

/** Whether a Stellar account (G...) exists on-chain, looked up server-side via Horizon. */
export function getAccountExists(token: string, walletId: string, account: string) {
  return apiFetch<{ exists: boolean }>(
    path`/v1/wallets/${walletId}/destinations/${account}`,
    { token },
  );
}

/** Upload (or replace) the encrypted backup blob stored server-side for a wallet. */
export function uploadBackup(token: string, walletId: string, encryptedBackup: string) {
  return apiFetch<{
    stored: boolean;
    /** Server-assigned version of the newly stored backup copy, when the backend reports one. */
    backup_version?: string | null;
  }>(path`/v1/wallets/${walletId}/backup`, {
    method: "PUT",
    token,
    body: JSON.stringify({ encrypted_backup: encryptedBackup }),
  });
}
