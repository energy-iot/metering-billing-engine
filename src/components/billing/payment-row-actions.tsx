"use client";

// PaymentRowActions — canonical action-column renderer for billing line items.
//
// Stacks vertically in the CopyTable Payment action column:
//   Row 1: <PaymentLinkButton> — generate a Pesapal hosted-checkout URL
//   Row 2: <PaymentStatusControl> — chip-as-trigger status dropdown
//
// This is the single render-point for anything payment-related in the
// action column. Future IPN chips from #121 will be added here.
//
// Coordination with #120: this ticket (#124) carries the wrap refactor.
// BillingTable's Payment action column now renders <PaymentRowActions>
// instead of <PaymentLinkButton> directly.

import * as React from "react";
import { PaymentLinkButton } from "@/components/billing/payment-link-button";
import {
  PaymentStatusControl,
  type PaymentStatus,
  type PaymentStatusControlLineItem,
} from "@/components/billing/payment-status-control";

export interface PaymentRowActionsProps {
  /** billing_line_items.id */
  lineItemId: string;
  /** Whether the community has a payment provider configured. */
  isPaymentConfigured: boolean;
  /**
   * The full line item data needed for <PaymentStatusControl>.
   * payment_status is the current Postgres enum value.
   */
  lineItem: PaymentStatusControlLineItem;
  /**
   * Called when the payment status is successfully updated so the parent
   * can refresh state if needed.
   */
  onStatusChange?: (newStatus: PaymentStatus) => void;
}

export function PaymentRowActions({
  lineItemId,
  isPaymentConfigured,
  lineItem,
  onStatusChange,
}: PaymentRowActionsProps) {
  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      {/* Payment link button — generate Pesapal hosted-checkout URL */}
      <PaymentLinkButton
        lineItemId={lineItemId}
        disabled={!isPaymentConfigured}
      />

      {/* Payment status chip + action dropdown */}
      <PaymentStatusControl lineItem={lineItem} onStatusChange={onStatusChange} />
    </div>
  );
}
