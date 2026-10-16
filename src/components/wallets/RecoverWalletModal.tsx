"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/dashboard/Modal";
import {
  fromMnemonic,
  encryptSeed,
  serializeBackup,
  uploadBackup,
  saveLocalBackup,
} from "@/lib/sdk";
import { assessPassword, PasswordStrengthMeter, MIN_PASSWORD_LENGTH, type PasswordAssessment } from "@/lib/passwordStrength";

type Step = "phrase" | "password" | "done";

/**
 * Recovery flow: enter the 12-word phrase, verify the derived public key matches the wallet
 * address, then re-encrypt under a new password and upload the backup. The mnemonic is cleared
 * from state immediately after use and is never sent to the server.
 */
export function RecoverWalletModal({
  token,
  walletId,
  walletAddress,
  onClose,
  onDone,
}: {
  token: string;
  walletId: string;
  walletAddress: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("phrase");
  const [phrase, setPhrase] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwFeedback, setPwFeedback] = useState<string[]>([]);
  const [pwAssessment, setPwAssessment] = useState<PasswordAssessment | null>(null);

  // Step 1: validate phrase and verify it matches the wallet address.
  async function handlePhraseSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const words = phrase.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
    if (words.length !== 12) {
      setError("Enter all 12 words of your recovery phrase.");
      return;
    }
    setBusy(true);
    try {
      const keys = fromMnemonic(phrase.trim());
      if (keys.publicKey !== walletAddress) {
        setError(
          "This phrase does not match this wallet's address. Check your words and try again.",
        );
        return;
      }
      setStep("password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid recovery phrase.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordChange(value: string) {
    setNewPassword(value);
    if (!value) { setPwFeedback([]); setPwAssessment(null); return; }
    try {
      const result = await assessPassword(value);
      setPwFeedback(result.feedback);
      setPwAssessment(result);
    } catch { setPwFeedback([]); setPwAssessment(null); }
  }

  // Step 2: re-encrypt the phrase under the new password and upload the backup.
  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    // Assess with the shared policy; fail closed if the estimator can't load.
    let assessment: PasswordAssessment;
    try {
      assessment = await assessPassword(newPassword);
    } catch {
      setError("Couldn't check password strength. Check your connection and try again.");
      return;
    }
    if (!assessment.acceptable) {
      setError("Choose a stronger password. " + (assessment.feedback[0] ?? ""));
      return;
    }
    setBusy(true);
    try {
      const keys = fromMnemonic(phrase.trim());
      const backup = await encryptSeed(keys.mnemonic, newPassword);
      const serialized = serializeBackup(backup);
      // Upload to the server first — only persist locally on success.
      const uploaded = await uploadBackup(token, walletId, serialized);
      saveLocalBackup(walletId, backup, uploaded.backup_version ?? serialized);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the backup.");
      toast.error("Recovery failed — please try again.");
    } finally {
      // Clear the mnemonic and password from state regardless of outcome.
      setPhrase("");
      setNewPassword("");
      setConfirmPassword("");
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <Modal title="Wallet recovered" onClose={onDone}>
        <div className="text-center">
          <p className="text-3xl text-burgundy-bright">✓</p>
          <p className="mt-2 font-medium text-foreground">Recovery complete</p>
          <p className="mt-1 text-sm text-muted">
            Your wallet is unlockable again with the new password on this device.
          </p>
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

  if (step === "password") {
    return (
      <Modal title="Set a new password" onClose={onClose}>
        <p className="text-sm text-muted">
          Choose a strong password to encrypt this wallet. You will need it every time you sign
          a transaction on this device.
        </p>
        <form onSubmit={handlePasswordSubmit} className="mt-5 space-y-4">
          <div>
            <label className="text-xs text-muted">New wallet password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => handlePasswordChange(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
            />
            {pwAssessment && (
              <PasswordStrengthMeter id="recover-wallet-password-strength" assessment={pwAssessment} />
            )}
            {pwFeedback.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {pwFeedback.map((f, i) => <li key={i}>· {f}</li>)}
              </ul>
            )}
          </div>
          <div>
            <label className="text-xs text-muted">Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat the password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
            />
          </div>
          {error && (
            <p className="rounded-lg border border-burgundy/40 bg-burgundy/10 px-3 py-2 text-sm text-burgundy-bright">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save and recover"}
          </button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Recover wallet" onClose={onClose}>
      <p className="text-sm text-muted">
        Enter the 12 words of your recovery phrase exactly as they were shown to you. The phrase
        never leaves this device — it is only used to re-create your key locally.
      </p>
      <form onSubmit={handlePhraseSubmit} className="mt-5 space-y-4">
        <div>
          <label className="text-xs text-muted">Recovery phrase (12 words)</label>
          <textarea
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 … word12"
            rows={3}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
        </div>
        {error && (
          <p className="rounded-lg border border-burgundy/40 bg-burgundy/10 px-3 py-2 text-sm text-burgundy-bright">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg glass-btn-primary py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {busy ? "Verifying…" : "Verify phrase"}
        </button>
      </form>
    </Modal>
  );
}
