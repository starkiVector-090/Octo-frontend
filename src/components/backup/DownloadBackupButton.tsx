"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { getBackup, loadLocalBackup, parseBackup, saveLocalBackup, decryptSeed, fromMnemonic } from "@/lib/sdk";

/** Export the encrypted backup as a .json file, or re-import one into this browser. */
export function DownloadBackupButton({
  token,
  walletId,
  address,
}: {
  token: string;
  walletId: string;
  address: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function download() {
    setBusy(true);
    try {
      // Prefer the local copy; fall back to the server-held blob.
      const cached = loadLocalBackup(walletId);
      let backup = cached?.backup ?? null;
      if (!backup) {
        const remote = await getBackup(token, walletId);
        if (!remote.encrypted_backup) throw new Error("No encrypted backup found for this wallet.");
        backup = parseBackup(remote.encrypted_backup);
      }
      const file = { wallet_id: walletId, address, backup };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `octo-backup-${(address ?? walletId).slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the backup.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (parsed?.wallet_id && parsed.wallet_id !== walletId) {
        throw new Error("This backup file belongs to a different wallet.");
      }
      if (parsed?.address && address && parsed.address !== address) {
        throw new Error("This backup file belongs to a different wallet.");
      }
      const blob = parsed?.backup ?? parsed;
      const backup = parseBackup(JSON.stringify(blob));

      // Confirm before replacing an existing local backup for this wallet.
      if (loadLocalBackup(walletId) && !window.confirm("A local backup already exists for this wallet. Replace it?")) {
        return;
      }

      // Validate the backup is usable and bound to this wallet: decrypt with the user's password
      // and confirm the derived key matches the wallet address.
      const password = window.prompt("Enter your wallet password to confirm this backup is yours.");
      if (password === null) return;
      const mnemonic = await decryptSeed(backup, password);
      const keypair = fromMnemonic(mnemonic).keypair;
      if (address && keypair.publicKey() !== address) {
        throw new Error("This backup does not belong to this wallet.");
      }

      saveLocalBackup(walletId, backup);
      toast.success("Backup imported. Unlock with your wallet password to use it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import the backup file.");
    }
  }

  const btn =
    "rounded-lg border border-border bg-surface-sunken px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-60";
  return (
    <div className="rounded-lg border border-border bg-surface-sunken/50 px-3 py-2 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={download} disabled={busy} className={btn}>
          {busy ? "Preparing…" : "Download encrypted backup"}
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} className={btn}>
          Import backup file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={onFile}
          className="hidden"
        />
      </div>
      <p className="mt-2">
        The file is encrypted and useless without your wallet password. Keep both safe; we cannot
        recover them for you.
      </p>
    </div>
  );
}
