"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "@/lib/api-client";
import type { ContactStatus, OpportunityStage } from "@/lib/crm";
import { CONTACT_STATUS_LABELS } from "@/lib/crm";

/** Small shared UI pieces for the CRM pages. Tailwind only, no UI library. */

export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900";

export const buttonClass = {
  primary:
    "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800",
  danger:
    "rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50",
  link: "text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400",
  linkDanger: "text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Modal: native <dialog> (focus trap, Esc to close and backdrop come from the browser)
// ---------------------------------------------------------------------------
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="modal-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {open && (
        <div className="p-5">
          <h2 id="modal-title" className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** "Are you sure?" dialog. onConfirm may throw; the error is shown and the dialog stays open. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        setError(null);
        onClose();
      }}
    >
      <div className="text-sm text-zinc-700 dark:text-zinc-300">{message}</div>
      {error && <ErrorBanner message={error} className="mt-3" />}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={buttonClass.secondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={buttonClass.danger} onClick={confirm} disabled={busy}>
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
export function ErrorBanner({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200 ${className}`}
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 font-medium underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------
const STATUS_COLORS: Record<ContactStatus, string> = {
  lead: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  prospect: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  customer: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
};

export function StatusBadge({ status }: { status: ContactStatus }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      {CONTACT_STATUS_LABELS[status]}
    </span>
  );
}

export const STAGE_COLORS: Record<OpportunityStage, string> = {
  new: "border-t-zinc-400",
  contacted: "border-t-sky-500",
  qualified: "border-t-indigo-500",
  proposal: "border-t-amber-500",
  won: "border-t-green-600",
  lost: "border-t-red-500",
};
