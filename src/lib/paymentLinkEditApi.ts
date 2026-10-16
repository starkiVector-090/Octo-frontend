/** Edit a payment link's mutable fields (URL and amount stay unchanged). */

import { apiFetch, path } from "./api";
import type { AuthToken, WalletId } from "./brands";
import type { PaymentLink } from "./payment-links";
import { validateRedirectUrl } from "./redirectUrl";

export type PaymentLinkEdit = {
  name: string;
  description?: string;
  imageUrl?: string | null;
  redirectUrl?: string;
};

/** Assumes `PUT /v1/wallets/:id/payment-links/:linkId` accepts these fields (null clears one). */
export function updatePaymentLink(
  token: AuthToken,
  walletId: WalletId,
  linkId: string,
  edit: PaymentLinkEdit,
) {
  return apiFetch<PaymentLink>(path`/v1/wallets/${walletId}/payment-links/${linkId}`, {
    method: "PUT",
    token,
    body: JSON.stringify({
      name: edit.name,
      description: edit.description || null,
      image_url: edit.imageUrl || null,
      redirect_url: edit.redirectUrl || null,
    }),
  });
}

/** Redirect targets must be https URLs; returns an error message or null. */
export { validateRedirectUrl };
