import type { Metadata } from "next";
import { LoadDemoControl } from "@/components/admin/load-demo-control";
import { PurgeReceiptsButton } from "@/components/admin/purge-receipts-button";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatBytes } from "@/lib/format";
import { log } from "@/lib/log";
import { type AdminStats, type AdminUserUsage, adminStats, adminUserUsage, sweepStaleReceipts } from "@/lib/receipts";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-US");

function Meter({ label, value, cap, format = (n: number) => nf.format(n) }: { label: string; value: number; cap: number; format?: (n: number) => string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  const fill = pct >= 90 ? "bg-blocked" : pct >= 70 ? "bg-building" : "bg-accent";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">
          {format(value)} of {format(cap)} ({pct}%)
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(value, cap)}
        aria-valuetext={`${format(value)} of ${format(cap)}`}
        className="h-2.5 w-full overflow-hidden rounded-card border border-border bg-background"
      >
        <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  await sweepStaleReceipts().catch((err) => log.warn("receipt.sweep_failed", { error: err instanceof Error ? err.message : "unknown" }));

  let stats: AdminStats | null = null;
  let users: AdminUserUsage[] = [];
  let error: string | null = null;
  try {
    [stats, users] = await Promise.all([adminStats(admin), adminUserUsage(admin)]);
  } catch (err) {
    log.error("admin.stats_failed", { error: err instanceof Error ? err.message : "unknown" });
    error = "Admin numbers could not be loaded. Try again in a moment.";
  }

  const columns: Column<AdminUserUsage>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (u) => (
        <span className="break-words">
          {u.name}
          {u.role === "admin" && <span className="ml-2 inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span>}
        </span>
      ),
    },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    { key: "expenses", header: "Expenses", className: "tabular-nums", cell: (u) => nf.format(u.expenses) },
    { key: "receipts", header: "Receipts", className: "tabular-nums", cell: (u) => nf.format(u.receipts) },
    { key: "bytes", header: "Stored", className: "whitespace-nowrap tabular-nums", cell: (u) => formatBytes(u.bytes) },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      hideLabel: true,
      className: "sm:text-right",
      cell: (u) => <PurgeReceiptsButton userId={u.id} name={u.name} receipts={u.receipts} />,
    },
  ];

  return (
    <>
      <PageIntro
        section="Admin"
        title="Admin"
        description="Usage against the limits, and the people who have signed up. You see counts and sizes only, never anyone's expenses or receipt images."
      />

      {error && (
        <p role="alert" className="mb-6 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {stats && (
        <>
          <StatGrid>
            <StatTile value={nf.format(stats.users)} label="Users" tone="accent" />
            <StatTile value={nf.format(stats.expenses)} label="Expenses" />
            <StatTile value={nf.format(stats.receipts)} label="Receipts stored" />
            <StatTile value={formatBytes(stats.receiptBytes)} label="Image storage used" />
          </StatGrid>

          <Panel title="Usage against limits">
            <div className="space-y-5">
              <Meter label="Image storage" value={stats.receiptBytes} cap={stats.receiptBytesCap} format={formatBytes} />
              <Meter label="Uploads today" value={stats.uploadsToday} cap={stats.uploadsCap} />
              <Meter label="Receipt readings today" value={stats.extractionsToday} cap={stats.extractionsCap} />
            </div>
            <p className="mt-4 text-sm text-muted">
              Each person can keep {nf.format(stats.receiptsPerUserCap)} receipts. Daily counts reset at midnight UTC.
            </p>
          </Panel>
        </>
      )}

      <Panel title="Tools">
        <LoadDemoControl />
      </Panel>

      <Panel title="People" count={error ? undefined : users.length}>
        {error ? (
          <p className="text-sm text-muted">The list is unavailable right now.</p>
        ) : (
          <DataList caption="People and their stored receipts" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
        )}
      </Panel>
    </>
  );
}
