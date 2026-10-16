"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/dashboard/Modal";
import {
  encryptSeed,
  decryptSeed,
  serializeBackup,
  uploadBackup,
  saveLocalBackup,
  loadLocalBackup,
  getBackup,
  parseBackup,
} from "@/lib/sdk";
import { assessPassword, PasswordStrengthMeter, MIN_PASSWORD_LENGTH, type PasswordAssessment } from "@/lib/passwordStrength";

/**
 * Change the wallet's encryption password:
 *  1. Decrypt the backup with the current password (proves ownership).
 *  2. Re-encrypt the mnemonic under the new password.
 *  3. Upload the new backup; only on success update localStorage.
 *
 * The local backup cache is refreshed from the authoritative server copy if it is stale (e.g. the
 * password was changed on another device), so the user's current password keeps working across
 * devices. The mnemonic lives in memory only for the duration of re-encryption and is cleared
 * immediately.
 */
export function ChangeWalletPasswordModal({
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwFeedback, setPwFeedback] = useState<string[]>([]);
  const [pwAssessment, setPwAssessment] = useState<PasswordAssessment | null>(null);
  const [done, setDone] = useState(false);

  async function handlePasswordChange(value: string) {
    setNewPassword(value);
    if (!value) { setPwFeedback([]); setPwAssessment(null); return; }
    try {
      const result = await assessPassword(value);
      setPwFeedback(result.feedback);
      setPwAssessment(result);
    } catch { setPwFeedback([]); setPwAssessment(null); }
  }

  /** Load the authoritative backup, refreshing the local cache if it is stale. */
  async function loadAuthoritativeBackup(password: string) {
    const local = loadLocalBackup(walletId);
    if (local) {
      try {
        const mnemonic = await decryptSeed(local.backup, password);
        return { mnemonic, backup: local.backup, version: local.version };
      } catch (err) {
        // Wrong password or a stale cache — fall through to the server copy below.
        if (!(err instanceof Error) || !/Incorrect password|corrupted backup/.test(err.message)) {
          throw err;
        }
      }
    }
    const remote = await getBackup(token, walletId);
    if (!remote || !remote.encrypted_backup) {
      throw new Error("No backup found for this wallet. Recover it with your recovery phrase first.");
    }
    const serverVersion = remote.backup_version ?? remote.encrypted_backup;
    if (!local || serverVersion !== local.version) {
      const parsed = parseBackup(remote.encrypted_backup);
      saveLocalBackup(walletId, parsed, serverVersion);
      const mnemonic = await decryptSeed(parsed, password);
      return { mnemonic, backup: parsed, version: serverVersion };
    }
    // Cache matches the server: the password is wrong.
    throw new Error("Incorrect password or corrupted backup.");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!currentPassword) {
      setError("Enter your current wallet password.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must differ from the current one.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    // Assess with the shared policy. If the estimator can't load, fail closed: never accept a
    // password we couldn't vet.
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
    let mnemonic = "";
    try {
      // Decrypt the current backup (local, refreshed from the server if stale). Throws on wrong
      // password or if no backup exists anywhere.
      const { mnemonic: decrypted } = await loadAuthoritativeBackup(currentPassword);
      mnemonic = decrypted;
      // Re-encrypt under new password.
      const newBackup = await encryptSeed(mnemonic, newPassword);
      const serialized = serializeBackup(newBackup);
      // Server first — only update locally after confirmed.
      const uploaded = await uploadBackup(token, walletId, serialized);
      // Refresh the local cache with the authoritative new copy + its server version.
      saveLocalBackup(walletId, newBackup, uploaded.backup_version ?? serialized);
      setDone(true);
      toast.success("Wallet password changed successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.");
    } finally {
      // Wipe the mnemonic and passwords from memory.
      mnemonic = "";
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="Password changed" onClose={onDone}>
        <div className="text-center">
          <p className="text-3xl text-burgundy-bright">✓</p>
          <p className="mt-2 font-medium text-foreground">Password updated</p>
          <p className="mt-1 text-sm text-muted">
            The new backup is stored on Octo and cached here. Other devices pick it up
            automatically the next time they unlock, so the new password works everywhere.
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

  return (
    <Modal title="Change wallet password" onClose={onClose}>
      <p className="text-sm text-muted">
        Decrypt your wallet with the current password, then choose a new one. The new backup is
        uploaded before your local copy is updated — if the upload fails, the old password still
        works. On other devices, the cached backup refreshes automatically on the next unlock.
      </p>
      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <div>
          <label className="text-xs text-muted">Current password</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current wallet password"
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs text-muted">New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => handlePasswordChange(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-burgundy-bright focus:outline-none"
          />
          {pwAssessment && (
            <PasswordStrengthMeter id="new-wallet-password-strength" assessment={pwAssessment} />
          )}
          {pwFeedback.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {pwFeedback.map((f, i) => <li key={i}>· {f}</li>)}
            </ul>
          )}
        </div>
        <div>
          <label className="text-xs text-muted">Confirm new password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat the new password"
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
          {busy ? "Updating…" : "Change password"}
        </button>
      </form>
    </Modal>
  );
}
