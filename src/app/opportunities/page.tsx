"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { ConfirmDialog, ErrorBanner, Field, Modal, STAGE_COLORS, buttonClass, inputClass } from "@/components/ui";
import { apiFetch, errorMessage, isAbortError } from "@/lib/api-client";
import {
  OPPORTUNITY_STAGES,
  STAGE_LABELS,
  formatRM,
  isOpenStage,
  type Contact,
  type Opportunity,
  type OpportunityInput,
  type OpportunityStage,
} from "@/lib/crm";

export default function OpportunitiesPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());

  const [editing, setEditing] = useState<Opportunity | "new" | null>(null);
  const [deleting, setDeleting] = useState<Opportunity | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      apiFetch<{ opportunities: Opportunity[] }>("/api/opportunities", { signal }),
      apiFetch<{ contacts: Contact[] }>("/api/contacts", { signal }),
    ])
      .then(([o, c]) => {
        setOpportunities(o.opportunities);
        setContacts(c.contacts);
        setError(null);
      })
      .catch((err) => {
        if (!isAbortError(err)) setError(errorMessage(err));
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  /** Optimistic stage change: move the card now, roll back if the API refuses. */
  async function changeStage(opp: Opportunity, stage: OpportunityStage) {
    const previous = opp.stage;
    const replace = (next: Opportunity) => setOpportunities((list) => list.map((o) => (o.id === opp.id ? next : o)));
    replace({ ...opp, stage });
    setSavingIds((ids) => new Set(ids).add(opp.id));
    setActionError(null);
    try {
      const { opportunity } = await apiFetch<{ opportunity: Opportunity }>(`/api/opportunities/${opp.id}`, {
        method: "PATCH",
        json: { stage },
      });
      replace(opportunity);
    } catch (err) {
      replace({ ...opp, stage: previous });
      setActionError(`Could not move “${opp.title}” to ${STAGE_LABELS[stage]}: ${errorMessage(err)}`);
    } finally {
      setSavingIds((ids) => {
        const next = new Set(ids);
        next.delete(opp.id);
        return next;
      });
    }
  }

  const openValue = opportunities.filter((o) => isOpenStage(o.stage)).reduce((sum, o) => sum + o.valueRm, 0);

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Opportunities</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {loading ? "Loading…" : `${opportunities.length} opportunities · open pipeline ${formatRM(openValue)}`}
          </p>
        </div>
        <button type="button" className={buttonClass.primary} onClick={() => setEditing("new")}>
          New opportunity
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={reload} className="mt-4" />}
      {actionError && <ErrorBanner message={actionError} className="mt-4" />}

      <div className="mt-6 grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
        {OPPORTUNITY_STAGES.map((stage) => {
          const cards = opportunities.filter((o) => o.stage === stage);
          const total = cards.reduce((sum, o) => sum + o.valueRm, 0);
          return (
            <section
              key={stage}
              aria-label={STAGE_LABELS[stage]}
              className={`flex min-h-48 flex-col rounded-md border border-t-4 border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 ${STAGE_COLORS[stage]}`}
            >
              <header className="flex items-baseline justify-between px-3 py-2">
                <h2 className="text-sm font-semibold">
                  {STAGE_LABELS[stage]} <span className="font-normal text-zinc-500">({cards.length})</span>
                </h2>
                <span className="text-xs tabular-nums text-zinc-500">{formatRM(total)}</span>
              </header>
              <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                {cards.map((o) => (
                  <OpportunityCard
                    key={o.id}
                    opportunity={o}
                    saving={savingIds.has(o.id)}
                    onStageChange={(s) => void changeStage(o, s)}
                    onEdit={() => setEditing(o)}
                    onDelete={() => setDeleting(o)}
                  />
                ))}
                {!loading && cards.length === 0 && <p className="px-1 py-4 text-center text-xs text-zinc-400">No opportunities</p>}
              </div>
            </section>
          );
        })}
      </div>

      <Modal
        open={editing !== null}
        title={editing === "new" ? "New opportunity" : "Edit opportunity"}
        onClose={() => setEditing(null)}
      >
        <OpportunityForm
          opportunity={editing === "new" ? null : editing}
          contacts={contacts}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete opportunity?"
        message={
          deleting && (
            <p>
              <strong>{deleting.title}</strong> ({formatRM(deleting.valueRm)}
              {deleting.contact ? `, ${deleting.contact.name}` : ""}) will be permanently deleted.
            </p>
          )
        }
        onConfirm={async () => {
          if (!deleting) return;
          await apiFetch(`/api/opportunities/${deleting.id}`, { method: "DELETE" });
          reload();
        }}
        onClose={() => setDeleting(null)}
      />
    </main>
  );
}

function OpportunityCard({
  opportunity: o,
  saving,
  onStageChange,
  onEdit,
  onDelete,
}: {
  opportunity: Opportunity;
  saving: boolean;
  onStageChange: (stage: OpportunityStage) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={`rounded-md border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 ${saving ? "opacity-60" : ""}`}>
      <h3 className="text-sm font-medium leading-snug">{o.title}</h3>
      <p className="mt-1 text-xs text-zinc-500">
        {o.contact ? `${o.contact.name}${o.contact.company ? ` · ${o.contact.company}` : ""}` : "Unknown contact"}
      </p>
      <p className="mt-2 text-sm font-semibold tabular-nums">{formatRM(o.valueRm)}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <select
          value={o.stage}
          disabled={saving}
          onChange={(e) => onStageChange(e.target.value as OpportunityStage)}
          aria-label={`Stage of ${o.title}`}
          className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          {OPPORTUNITY_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <span className="flex gap-2">
          <button type="button" className={`${buttonClass.link} text-xs`} onClick={onEdit} disabled={saving}>
            Edit
          </button>
          <button type="button" className={`${buttonClass.linkDanger} text-xs`} onClick={onDelete} disabled={saving}>
            Delete
          </button>
        </span>
      </div>
    </article>
  );
}

function OpportunityForm({
  opportunity,
  contacts,
  onSaved,
  onCancel,
}: {
  opportunity: Opportunity | null;
  contacts: Contact[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(opportunity?.title ?? "");
  const [contactId, setContactId] = useState(opportunity?.contactId ?? "");
  const [value, setValue] = useState(opportunity ? String(opportunity.valueRm) : "");
  const [stage, setStage] = useState<OpportunityStage>(opportunity?.stage ?? "new");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (contacts.length === 0) {
    return (
      <div className="space-y-4 text-sm">
        <p>An opportunity must belong to a contact, and there are no contacts yet.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.secondary} onClick={onCancel}>
            Close
          </button>
          <Link href="/leads" className={buttonClass.primary}>
            Add a contact
          </Link>
        </div>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload: OpportunityInput = {
      title: title.trim(),
      contactId,
      valueRm: value.trim() === "" ? 0 : Number(value),
      stage,
    };
    try {
      if (opportunity) {
        await apiFetch(`/api/opportunities/${opportunity.id}`, { method: "PATCH", json: payload });
      } else {
        await apiFetch("/api/opportunities", { method: "POST", json: payload });
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const sortedContacts = [...contacts].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Title *" htmlFor="o-title">
        <input
          id="o-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. e-Invoice readiness training (20 pax)"
          className={inputClass}
          autoFocus
        />
      </Field>
      <Field label="Contact *" htmlFor="o-contact">
        <select id="o-contact" required value={contactId} onChange={(e) => setContactId(e.target.value)} className={inputClass}>
          <option value="" disabled>
            Choose a contact…
          </option>
          {sortedContacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.company ? ` (${c.company})` : ""}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Value (RM)" htmlFor="o-value">
          <input
            id="o-value"
            type="number"
            inputMode="decimal"
            min={0}
            max={9_999_999_999.99}
            step={0.01}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
            className={inputClass}
          />
        </Field>
        <Field label="Stage" htmlFor="o-stage">
          <select id="o-stage" value={stage} onChange={(e) => setStage(e.target.value as OpportunityStage)} className={inputClass}>
            {OPPORTUNITY_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {value.trim() !== "" && Number.isFinite(Number(value)) && (
        <p className="text-xs text-zinc-500">{formatRM(Number(value))}</p>
      )}

      {error && <ErrorBanner message={error} />}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className={buttonClass.secondary} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={saving}>
          {saving ? "Saving…" : opportunity ? "Save changes" : "Create opportunity"}
        </button>
      </div>
    </form>
  );
}
