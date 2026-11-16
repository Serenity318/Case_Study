"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ErrorBanner } from "@/components/ui";
import { apiFetch, errorMessage, isAbortError } from "@/lib/api-client";
import { STAGE_LABELS, formatRM, timeAgo, type DashboardData } from "@/lib/crm";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<DashboardData>("/api/dashboard", { signal: controller.signal })
      .then((d) => {
        setData(d);
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((err) => {
        if (!isAbortError(err)) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  const t = data?.totals;
  const maxStageValue = Math.max(1, ...(data?.byStage.map((s) => s.valueRm) ?? []));

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      {error && <ErrorBanner message={error} onRetry={() => setReloadKey((k) => k + 1)} className="mt-4" />}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Total contacts" value={t ? t.contacts.toLocaleString("en-MY") : null} href="/leads" />
        <StatCard
          label="Open opportunities"
          value={t ? t.openOpportunities.toLocaleString("en-MY") : null}
          sub={t ? `of ${t.opportunities} total · ${formatRM(t.openValueRm)} in pipeline` : undefined}
          href="/opportunities"
        />
        <StatCard
          label="Total opportunity value"
          value={t ? formatRM(t.totalValueRm) : null}
          sub={t ? `${formatRM(t.wonValueRm)} won` : undefined}
          href="/opportunities"
        />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Recent activity</h2>
          {!data && !error && <SkeletonRows />}
          {data && data.recentActivity.length === 0 && (
            <p className="mt-3 text-sm text-zinc-500">No activity yet. Add a contact on the Leads page, or run npm.cmd run seed.</p>
          )}
          {data && data.recentActivity.length > 0 && (
            <ol className="mt-3 divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {data.recentActivity.map((a) => (
                <li key={`${a.type}-${a.id}`} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.type === "contact" ? "bg-sky-500" : "bg-amber-500"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p>
                      <span className="text-zinc-500">
                        {a.type === "contact" ? "Contact" : "Opportunity"} {a.action}:{" "}
                      </span>
                      <Link
                        href={a.type === "contact" ? "/leads" : "/opportunities"}
                        className="font-medium hover:underline"
                      >
                        {a.label}
                      </Link>
                    </p>
                    {a.detail && <p className="truncate text-xs text-zinc-500">{a.detail}</p>}
                  </div>
                  <time dateTime={a.at} title={new Date(a.at).toLocaleString("en-MY")} className="shrink-0 text-xs text-zinc-500">
                    {timeAgo(a.at, loadedAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            Latest created or updated contacts and opportunities. Deletions are not shown.
          </p>
        </section>

        <section className="lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Pipeline by stage</h2>
          {!data && !error && <SkeletonRows />}
          {data && (
            <ul className="mt-3 space-y-3">
              {data.byStage.map((s) => (
                <li key={s.stage} className="text-sm">
                  <div className="flex justify-between">
                    <span>
                      {STAGE_LABELS[s.stage]} <span className="text-zinc-500">({s.count})</span>
                    </span>
                    <span className="tabular-nums">{formatRM(s.valueRm)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={`h-1.5 rounded ${s.stage === "won" ? "bg-green-600" : s.stage === "lost" ? "bg-red-400" : "bg-blue-500"}`}
                      style={{ width: `${(s.valueRm / maxStageValue) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function StatCard({ label, value, sub, href }: { label: string; value: string | null; sub?: string; href: string }) {
  return (
    <Link
      href={href}
      className="block rounded-md border border-zinc-200 p-4 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
    >
      <p className="text-sm text-zinc-500">{label}</p>
      {value === null ? (
        <div className="mt-2 h-7 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      )}
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </Link>
  );
}

function SkeletonRows() {
  return (
    <div className="mt-3 space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
      ))}
    </div>
  );
}
