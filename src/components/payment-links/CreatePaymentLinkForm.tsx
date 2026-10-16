"use client";

import { useState, type FormEvent } from "react";
import { Modal } from "@/components/dashboard/Modal";
import { ActionButton } from "@/components/dashboard/WalletUI";
import { uploadImage, validateImage } from "@/lib/uploads";
import { isTrustedImageUrl } from "@/lib/isTrustedImageUrl";
import { validateRedirectUrl } from "@/lib/redirectUrl";
import { asAuthToken, asWalletId } from "@/lib/brands";
import { usdAmountToStroops, createPaymentLink, type PaymentLink } from "@/lib/payment-links";

export function CreatePaymentLinkForm({
  walletId,
  token,
  creating,
  setCreating,
  onClose,
  onCreated,
}: {
  walletId: string;
  token: string | null;
  creating: boolean;
  setCreating: (v: boolean) => void;
  onClose: () => void;
  onCreated: (link: PaymentLink) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !token) return;
    setUploading(true);
    setError(null);
    try {
      await validateImage(file);
      setImageUrl(await uploadImage(token, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const amountUsdcStroops = amount.trim() ? usdAmountToStroops(amount.trim()) : undefined;
      if (amount.trim() && amountUsdcStroops === null) {
        setError("Enter a valid positive amount, or leave it blank for a flexible amount.");
        setCreating(false);
        return;
      }
      const redirectError = validateRedirectUrl(redirectUrl.trim());
      if (redirectError) {
        setError(redirectError);
        setCreating(false);
        return;
      }
      const link = await createPaymentLink(asAuthToken(token), asWalletId(walletId), {
        name: name.trim(),
        description: description.trim() || undefined,
        imageUrl: imageUrl ?? undefined,
        redirectUrl: redirectUrl.trim() || undefined,
        amountUsdcStroops: amountUsdcStroops ?? undefined,
      });
      onCreated(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the link.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title="Create payment link" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground">
            Image (optional)
          </label>
          <div className="mt-1 flex items-center gap-3">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-sunken">
              {isTrustedImageUrl(imageUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl!} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-lg text-muted">🖼</span>
              )}
            </div>
            <div className="flex-1">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                disabled={uploading}
                className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface-raised file:px-3 file:py-1.5 file:text-xs file:text-foreground hover:file:border-burgundy/50"
              />
              <p className="mt-1 text-[11px] text-muted">
                {uploading
                  ? "Uploading…"
                  : imageUrl
                    ? "Uploaded. Choose another file to replace it."
                    : "PNG or JPG, up to 2MB."}
              </p>
            </div>
          </div>
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Product payment"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground outline-none focus:border-burgundy/50"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">
            Description (optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this payment link"
            rows={2}
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground outline-none focus:border-burgundy/50"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">Amount (USD)</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Leave empty for flexible amount"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground outline-none focus:border-burgundy/50"
          />
          <p className="mt-1 text-[11px] text-muted">
            Settled 1:1 in USDC. Leave empty to let the payer choose their own amount.
          </p>
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">
            Redirect URL (optional)
          </label>
          <input
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="https://your-site.com/thank-you"
            className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-foreground outline-none focus:border-burgundy/50"
          />
          <p className="mt-1 text-[11px] text-muted">
            Where to send customers after a successful payment.
          </p>
        </div>

        {error && (
          <p className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-sm text-foreground transition-colors hover:border-burgundy/50"
          >
            Cancel
          </button>
          <ActionButton
            label={creating ? "Creating…" : "Create Link"}
            disabled={!name.trim() || creating || uploading}
            loading={creating}
          />
        </div>
      </form>
    </Modal>
  );
}
