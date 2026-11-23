import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRight, Eye, Pause, Play, Radio, ShieldCheck, Trash2 } from "lucide-react"
import {
  SIGNALS,
  api,
  formatNumber,
  type LiveContent,
  type LiveEntry,
  type LiveTarget,
  type LiveTargetStatus,
  type PodsReport,
  type Signal
} from "../api"
import { useRouterData } from "../App"
import { JsonViewer } from "../json"
import { AgentName, ErrorBanner, PageHeader } from "../ui"
import { PodsNotice } from "./Overview"

const POLL_MS = 2000
const KEEP = 300
// Replica clocks differ a little, so each poll asks again for the last few seconds.
const OVERLAP_MS = 5000

const STATUS_STYLE: Record<LiveTargetStatus, string> = {
  sent: "border-success/40 bg-success/10 text-success",
  queued: "border-line bg-well text-muted",
  retrying: "border-warn/40 bg-warn/10 text-warn",
  filtered: "border-line bg-well text-faint",
  dropped: "border-danger/40 bg-danger/10 text-danger",
  failed: "border-danger/40 bg-danger/10 text-danger"
}

const NAMES_LABEL: Record<Signal, string> = { traces: "Span names", metrics: "Metric names", logs: "Event names" }

function hasProblem(e: LiveEntry): boolean {
  return e.status === "rejected" || (e.targets ?? []).some((t) => ["failed", "dropped", "retrying"].includes(t.status))
}

/** Every kind of change a target's filters made, in the order shown. */
function changes(t: LiveTarget): string[] {
  const out: string[] = []
  if (t.redacted) out.push(`${formatNumber(t.redacted)} ${t.redacted === 1 ? "secret" : "secrets"} redacted`)
  if (t.masked) out.push(`${formatNumber(t.masked)} masked`)
  if (t.hashed) out.push(`${formatNumber(t.hashed)} hashed`)
  if (t.removed) out.push(`${formatNumber(t.removed)} removed`)
  if (t.itemsRemoved) out.push(`${formatNumber(t.itemsRemoved)} ${t.itemsRemoved === 1 ? "record" : "records"} dropped`)
  return out
}

/** What a target's filters did, in words. */
function filterSummary(t: LiveTarget): string {
  const done = changes(t)
  if (done.length) return done.join(", ")
  return t.rules ? `Nothing to change (${t.rules} ${t.rules === 1 ? "rule" : "rules"})` : "No filters, sent as received"
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function useLive(paused: boolean) {
  const [entries, setEntries] = useState<LiveEntry[]>([])
  const [pods, setPods] = useState<PodsReport>()
  const [error, setError] = useState<string>()
  const byId = useRef(new Map<string, LiveEntry>())
  const since = useRef(0)
  const clearedAt = useRef(0)

  useEffect(() => {
    if (paused) return
    let stopped = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await api.live(since.current)
        if (stopped) return
        for (const e of res.entries) {
          if (e.time > clearedAt.current) byId.current.set(e.id, e)
          since.current = Math.max(since.current, e.updatedAt - OVERLAP_MS)
        }
        const next = [...byId.current.values()].sort((a, b) => b.time - a.time).slice(0, KEEP)
        byId.current = new Map(next.map((e) => [e.id, e]))
        setEntries(next)
        setPods(res.pods)
        setError(undefined)
      } catch (err) {
        if (!stopped) setError((err as Error).message)
      }
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [paused])

  const clear = () => {
    clearedAt.current = Date.now()
    byId.current.clear()
    setEntries([])
  }
  return { entries, pods, error, clear }
}

export default function Live() {
  const { targets, info } = useRouterData()
  const [paused, setPaused] = useState(false)
  const [signal, setSignal] = useState<Signal | "all">("all")
  const [problemsOnly, setProblemsOnly] = useState(false)
  const { entries, pods, error, clear } = useLive(paused)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const targetName = (id: string) => targets.find((t) => t.id === id)?.name ?? id
  const order = (id: string) => {
    const i = targets.findIndex((t) => t.id === id)
    return i < 0 ? targets.length : i
  }
  const shown = entries
    .filter((e) => (signal === "all" || e.signal === signal) && (!problemsOnly || hasProblem(e)))
    .map((e) => ({ ...e, targets: [...(e.targets ?? [])].sort((a, b) => order(a.id) - order(b.id)) }))

  return (
    <>
      <PageHeader
        title="Live"
        description={
          info?.liveContent
            ? "The latest requests agents sent to this router, what each target did with them, and whether its filters redacted anything. Kept only in memory. The telemetry of the newest requests can be opened to check."
            : "The latest requests agents sent to this router, what each target did with them, and whether its filters redacted anything. Only who sent what and where it went is kept, never the telemetry itself, and only in memory."
        }
        action={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setPaused(!paused)}>
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button className="btn-ghost" onClick={clear}>
              <Trash2 className="size-4" /> Clear
            </button>
          </div>
        }
      />
      <PodsNotice pods={pods} />
      <ErrorBanner message={error} />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {(["all", ...SIGNALS] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSignal(s)}
            className={`chip ${signal === s ? "border-primary/50 bg-primary/10 text-fg" : "hover:text-fg"}`}
          >
            {s}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
          Problems only
        </label>
      </div>

      <section className="card divide-y divide-line">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted">
            <Radio className={`size-5 text-faint ${paused ? "" : "animate-pulse"}`} />
            {paused ? "Paused." : "Waiting for requests."}
          </div>
        ) : (
          shown.map((e) => (
            <Row
              key={e.id}
              entry={e}
              targetName={targetName}
              content={!!info?.liveContent}
              open={expanded.has(e.id)}
              onToggle={() => toggle(e.id)}
            />
          ))
        )}
      </section>
    </>
  )
}

function Row({
  entry: e,
  targetName,
  content,
  open,
  onToggle
}: {
  entry: LiveEntry
  targetName: (id: string) => string
  content: boolean
  open: boolean
  onToggle: () => void
}) {
  const agents = Object.keys(e.agents ?? {})
  const errors = (e.targets ?? []).filter((t) => t.error && t.status !== "sent")
  return (
    <div className={`text-sm ${open ? "bg-well/60" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-5 pt-3 text-left hover:bg-well/60"
      >
        <ChevronRight className={`-ml-1 size-4 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="w-20 font-mono text-xs text-faint tabular-nums">{clock(e.time)}</span>
        <span className="chip w-20 justify-center">{e.signal || "unknown"}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {e.status === "rejected" ? (
              <span className="text-danger">Rejected</span>
            ) : agents.length ? (
              agents.map((a, i) => (
                <Fragment key={a}>
                  {i > 0 && ", "}
                  <AgentName slug={a} />
                </Fragment>
              ))
            ) : (
              "Unknown agent"
            )}
            {e.status === "accepted" && <span className="ml-2 text-xs font-normal text-faint">{formatNumber(e.items)} items</span>}
          </div>
          <div className="truncate text-xs text-faint">
            {[e.user, e.device, e.token && `${e.token} token`].filter(Boolean).join(" · ") || "no sender details"}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {(e.targets ?? []).map((t) => (
            <span
              key={t.id}
              title={t.error ?? filterSummary(t)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${STATUS_STYLE[t.status]}`}
            >
              {targetName(t.id)}: {t.status}
              {changes(t).length > 0 && <ShieldCheck className="size-3" aria-label="Filters changed the data" />}
            </span>
          ))}
          {e.status === "accepted" && !e.targets?.length && <span className="text-xs text-faint">no target took it</span>}
        </div>
        <div className="w-full pb-3 pl-28">
          {!open && e.error && <div className="truncate text-xs text-danger">{e.error}</div>}
          {!open &&
            errors.map((t) => (
              <div key={t.id} className="mt-1 truncate text-xs text-danger">
                {targetName(t.id)}: {t.error}
              </div>
            ))}
        </div>
      </button>
      {open && <Details entry={e} targetName={targetName} content={content} />}
    </div>
  )
}

function Details({ entry: e, targetName, content }: { entry: LiveEntry; targetName: (id: string) => string; content: boolean }) {
  const names = Object.entries(e.names ?? {}).sort((a, b) => b[1] - a[1])
  const agents = Object.entries(e.agents ?? {}).sort((a, b) => b[1] - a[1])
  const fields: [string, ReactNode][] = [
    ["Received", new Date(e.time).toLocaleString()],
    ["Last update", new Date(e.updatedAt).toLocaleString()],
    ["Signal", e.signal || "unknown"],
    ["Status", e.status === "rejected" ? <span className="text-danger">rejected</span> : "accepted"],
    ["Items", formatNumber(e.items)],
    ...(e.status === "accepted" ? ([["Redaction", <Redaction targets={e.targets ?? []} targetName={targetName} />]] as [string, ReactNode][]) : []),
    ["User", e.user],
    ["Device", e.device],
    ["Ingest token", e.token],
    ["Request id", <span className="font-mono">{e.id}</span>]
  ]
  return (
    <div className="space-y-5 px-5 pt-1 pb-5 pl-28">
      {e.error && <p className="text-xs break-words text-danger">{e.error}</p>}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs md:grid-cols-3">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="label mb-0.5">{label}</dt>
            <dd className="break-words text-fg">{value || <span className="text-faint">not sent</span>}</dd>
          </div>
        ))}
      </dl>

      {agents.length > 0 && (
        <div>
          <div className="label">Agents</div>
          <div className="flex flex-wrap gap-1.5">
            {agents.map(([a, n]) => (
              <span key={a} className="chip">
                <AgentName slug={a} /> {formatNumber(n)}
              </span>
            ))}
          </div>
        </div>
      )}

      {names.length > 0 && (
        <div>
          <div className="label">{NAMES_LABEL[e.signal || "logs"]}</div>
          <div className="flex flex-wrap gap-1.5">
            {names.map(([n, c]) => (
              <span key={n} className="chip font-mono">
                {n} <span className="text-faint">×{formatNumber(c)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {(e.targets ?? []).length > 0 && (
        <div>
          <div className="label">Targets</div>
          <table className="w-full text-left text-xs">
            <thead className="text-faint">
              <tr>
                <th className="py-1 pr-4 font-medium">Target</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 pr-4 font-medium">Items</th>
                <th className="py-1 pr-4 font-medium">Filters</th>
                <th className="py-1 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {e.targets!.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="py-1.5 pr-4 whitespace-nowrap">{targetName(t.id)}</td>
                  <td className="py-1.5 pr-4">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 ${STATUS_STYLE[t.status]}`}>{t.status}</span>
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums">{t.status === "filtered" ? "0" : formatNumber(t.items)}</td>
                  <td className={`py-1.5 pr-4 ${changes(t).length ? "text-fg" : "text-faint"}`}>{filterSummary(t)}</td>
                  <td className="py-1.5 break-all text-danger">{t.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {content && <Content entry={e} targetName={targetName} />}

      <p className="text-[11px] text-faint">
        {content
          ? "The router keeps these details, and the telemetry of the newest requests in memory only. Nothing is written to disk."
          : "The router keeps only these details. The telemetry itself is forwarded and never stored."}
      </p>
    </div>
  )
}

/** Whether any target's filters changed this request, and which. */
function Redaction({ targets, targetName }: { targets: LiveTarget[]; targetName: (id: string) => string }) {
  if (targets.length === 0) return null
  const changed = targets.filter((t) => changes(t).length > 0)
  if (changed.length === 0) {
    return targets.some((t) => t.rules)
      ? "No, the filters found nothing to change"
      : "No, no target has filters"
  }
  return (
    <div className="space-y-0.5">
      <div className="inline-flex items-center gap-1.5 font-medium text-success">
        <ShieldCheck className="size-3.5" /> Yes
      </div>
      {changed.map((t) => (
        <div key={t.id} className="text-muted">
          {targetName(t.id)}: {changes(t).join(", ")}
        </div>
      ))}
    </div>
  )
}

/** The request's telemetry, loaded on demand: as received and as each target got it. */
function Content({ entry: e, targetName }: { entry: LiveEntry; targetName: (id: string) => string }) {
  const [state, setState] = useState<{ content?: LiveContent; error?: string; loading?: boolean }>({})
  const load = async () => {
    setState({ loading: true })
    try {
      setState({ content: await api.liveContent(e.id) })
    } catch (err) {
      setState({ error: (err as Error).message })
    }
  }
  const { content } = state
  return (
    <div>
      <div className="label">Telemetry</div>
      {!content && (
        <button className="btn-ghost" onClick={load} disabled={state.loading}>
          <Eye className="size-4" /> {state.loading ? "Loading" : "Show telemetry"}
        </button>
      )}
      {state.error && <p className="mt-2 text-xs text-danger">{state.error}</p>}
      {content && !content.available && (
        <p className="text-xs text-muted">
          The telemetry of this request is no longer kept. Only the newest requests keep it.
        </p>
      )}
      {content?.available && content.skipped && <p className="text-xs text-muted">{content.skipped}</p>}
      {content?.available && !content.skipped && (
        <div className="grid gap-4 xl:grid-cols-2">
          <JsonViewer title="Received" value={content.received} />
          {(e.targets ?? []).map((t) => {
            const sent = content.targets?.[t.id]
            return sent === undefined ? (
              <div key={t.id}>
                <div className="mb-1 text-[11px] tracking-wide text-primary uppercase">Sent to {targetName(t.id)}</div>
                <p className="text-xs text-muted">
                  {t.status === "filtered" ? "Nothing: the filters removed everything." : "Not kept."}
                </p>
              </div>
            ) : (
              <JsonViewer key={t.id} title={`Sent to ${targetName(t.id)}`} value={sent} highlight />
            )
          })}
        </div>
      )}
    </div>
  )
}
