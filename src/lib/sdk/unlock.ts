/**
 * Unlock a wallet for signing: derive the keypair from the user's password + the cached backup,
 * keeping the local cache consistent with the authoritative server copy.
 *
 * The local cache is preferred (no network) when it decrypts. If decryption fails — either a
 * wrong password or a stale cache left behind by a credential change on another device — the
 * server copy is fetched and used to refresh the local cache so the user's current password
 * keeps working across devices.
 */
import { Keypair } from "@stellar/stellar-base";
import { decryptSeed } from "./crypto";
import { fromMnemonic } from "./keys";
import { getBackup } from "./client";
import { loadLocalBackup, saveLocalBackup } from "./store";
import { parseBackup } from "./crypto";

export const MISSING_BACKUP_ERROR =
  'No key backup found for this wallet. Use "Recover wallet" on the wallet overview page.';

/** The decryption failed because the password is wrong (not a malformed blob). */
function isWrongPasswordError(err: unknown): boolean {
  return err instanceof Error && /Incorrect password|corrupted backup/.test(err.message);
}

/** Decrypt + unlock from a specific backup blob; throws on wrong password or key mismatch. */
async function unlockFromBackup(
  backup: ReturnType<typeof parseBackup>,
  password: string,
  expectedPublicKey?: string,
): Promise<Keypair> {
  const mnemonic = await decryptSeed(backup, password);
  const keypair = fromMnemonic(mnemonic).keypair;
  if (expectedPublicKey !== undefined && keypair.publicKey() !== expectedPublicKey) {
    throw new Error("Unlocked key does not match this wallet. Aborting unlock.");
  }
  return keypair;
}

export async function unlockWallet(
  token: string,
  walletId: string,
  password: string,
  expectedPublicKey?: string,
): Promise<Keypair> {
  const local = loadLocalBackup(walletId);

  // Fast path: the cached copy decrypts — no network round-trip.
  if (local) {
    try {
      return await unlockFromBackup(local.backup, password, expectedPublicKey);
    } catch (err) {
      // Decryption failed: either a wrong password, or the cache is stale (e.g. the password was
      // changed on another device). Only wrong-password errors fall through to the server check;
      // anything else (malformed blob) is rethrown.
      if (!isWrongPasswordError(err)) throw err;
    }
  }

  // Fetch the authoritative server copy and refresh a stale cache before decrypting.
  const remote = await getBackup(token, walletId);
  if (!remote || !remote.encrypted_backup) {
    throw new Error(MISSING_BACKUP_ERROR);
  }

  const serverVersion = remote.backup_version ?? remote.encrypted_backup;
  const localVersion = local?.version ?? "";

  if (!local || serverVersion !== localVersion) {
    // Stale or missing cache — replace it with the server-authoritative copy.
    const parsed = parseBackup(remote.encrypted_backup);
    saveLocalBackup(walletId, parsed, serverVersion);
    return unlockFromBackup(parsed, password, expectedPublicKey);
  }

  // Cache version matches the server: the password is simply wrong.
  throw new Error("Incorrect password or corrupted backup.");
}
