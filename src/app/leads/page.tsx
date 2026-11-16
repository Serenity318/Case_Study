"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ConfirmDialog, ErrorBanner, Field, Modal, StatusBadge, buttonClass, inputClass } from "@/components/ui";
import { apiFetch, errorMessage, isAbortError } from "@/lib/api-client";
import {
  CONTACT_STATUSES,
  CONTACT_STATUS_LABELS,
  timeAgo,
  type Contact,
  type ContactInput,
  type ContactStatus,
} from "@/lib/crm";

const SEARCH_DELAY_MS = 250;

export default function LeadsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | ContactStatus>("");
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);

  // Load (debounced while typing). Each new search cancels the previous request.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (status) params.set("status", status);
      apiFetch<{ contacts: Contact[] }>(`/api/contacts?${params}`, { signal: controller.signal })
        .then((data) => {
          setContacts(data.contacts);
          setLoadedAt(Date.now());
          setError(null);
        })
        .catch((err) => {
          if (!isAbortError(err)) setError(errorMessage(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const filtered = search.trim() !== "" || status !== "";

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">All contacts: leads, prospects and customers.</p>
        </div>
        <button type="button" className={buttonClass.primary} onClick={() => setEditing("new")}>
          New contact
        </button>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email or company"
          aria-label="Search contacts"
          maxLength={100}
          className={`${inputClass} max-w-sm`}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "" | ContactStatus)}
          aria-label="Filter by status"
          className={`${inputClass} w-auto`}
        >
          <option value="">All statuses</option>
          {CONTACT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONTACT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {loading && <span className="self-center text-sm text-zinc-500">Loading…</span>}
      </div>

      {error && <ErrorBanner message={error} onRetry={reload} className="mt-4" />}

      <div className="mt-4 overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Phone</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Opps</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {contacts.map((c) => (
              <tr key={c.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">{c.company ?? "–"}</td>
                <td className="px-3 py-2">
                  {c.email ? (
                    <a href={`mailto:${c.email}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      {c.email}
                    </a>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{c.phone ?? "–"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{c.opportunityCount}</td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">{timeAgo(c.updatedAt, loadedAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button type="button" className={buttonClass.link} onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button type="button" className={`${buttonClass.linkDanger} ml-3`} onClick={() => setDeleting(c)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!loading && !error && contacts.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-zinc-500">
                  {filtered
                    ? "No contacts match this search."
                    : "No contacts yet. Add one, or run npm.cmd run seed to load sample data."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!loading && contacts.length > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {contacts.length} contact{contacts.length === 1 ? "" : "s"}
        </p>
      )}

      <Modal open={editing !== null} title={editing === "new" ? "New contact" : "Edit contact"} onClose={() => setEditing(null)}>
        <ContactForm
          contact={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete contact?"
        message={
          deleting && (
            <>
              <p>
                <strong>{deleting.name}</strong>
                {deleting.company ? ` (${deleting.company})` : ""} will be permanently deleted.
              </p>
              {deleting.opportunityCount > 0 && (
                <p className="mt-2 font-medium text-red-700 dark:text-red-300">
                  This also deletes their {deleting.opportunityCount} opportunit
                  {deleting.opportunityCount === 1 ? "y" : "ies"}.
                </p>
              )}
            </>
          )
        }
        onConfirm={async () => {
          if (!deleting) return;
          await apiFetch(`/api/contacts/${deleting.id}`, { method: "DELETE" });
          reload();
        }}
        onClose={() => setDeleting(null)}
      />
    </main>
  );
}

function ContactForm({
  contact,
  onSaved,
  onCancel,
}: {
  contact: Contact | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [company, setCompany] = useState(contact?.company ?? "");
  const [status, setStatus] = useState<ContactStatus>(contact?.status ?? "lead");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload: ContactInput = {
      name: name.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      company: company.trim() || null,
      status,
    };
    try {
      if (contact) {
        await apiFetch(`/api/contacts/${contact.id}`, { method: "PATCH", json: payload });
      } else {
        await apiFetch("/api/contacts", { method: "POST", json: payload });
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name *" htmlFor="c-name">
        <input id="c-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
      </Field>
      <Field label="Company" htmlFor="c-company">
        <input id="c-company" maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" htmlFor="c-email">
          <input id="c-email" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Phone" htmlFor="c-phone">
          <input
            id="c-phone"
            type="tel"
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+60 12-345 6789"
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="Status" htmlFor="c-status">
        <select id="c-status" value={status} onChange={(e) => setStatus(e.target.value as ContactStatus)} className={inputClass}>
          {CONTACT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONTACT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>

      {error && <ErrorBanner message={error} />}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className={buttonClass.secondary} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={saving}>
          {saving ? "Saving…" : contact ? "Save changes" : "Create contact"}
        </button>
      </div>
    </form>
  );
}
