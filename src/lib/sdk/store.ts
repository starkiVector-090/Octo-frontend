/**
 * Local (browser) persistence of the encrypted seed backup, keyed by wallet id.
 *
 * The blob is the same opaque ciphertext the server stores and is useless without the user's
 * password. Storage is an optional cache because browser policy can make localStorage fail.
 *
 * Each cached copy is stamped with a `version` — the server-authoritative `encrypted_backup`
 * string it was copied from. On unlock, if the local version differs from the server's, the
 * cache is stale (e.g. the password was changed on another device) and is refreshed before
 * decryption so the user's current password keeps working across devices.
 */
import { parseBackup, type EncryptedBackup } from "./crypto";

const PREFIX = "octo_wallet_backup_";

function notifyStorageFailure() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("octo-storage-warning", {
      detail:
        "This browser could not cache your encrypted wallet backup. You can continue, but the backup will be fetched from Octo when needed.",
    }),
  );
}

/** A cached copy of the server's encrypted backup, stamped with its content version. */
export interface CachedBackup {
  backup: EncryptedBackup;
  /** The `encrypted_backup` string this copy was taken from; empty when unknown. */
  version: string;
}

export function saveLocalBackup(
  walletId: string,
  backup: EncryptedBackup,
  version: string = "",
): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(PREFIX + walletId, JSON.stringify({ backup, version }));
    return true;
  } catch {
    notifyStorageFailure();
    return false;
  }
}

export function loadLocalBackup(walletId: string): CachedBackup | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFIX + walletId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { backup?: unknown; version?: unknown };
    if (!parsed || typeof parsed.backup !== "object") return null;
    return {
      backup: parseBackup(JSON.stringify(parsed.backup)),
      version: typeof parsed.version === "string" ? parsed.version : "",
    };
  } catch {
    return null;
  }
}

export function clearLocalBackups() {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    notifyStorageFailure();
  }
}
