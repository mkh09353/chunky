import {
  MagnifyingGlassIcon,
  WrenchScrewdriverIcon,
  ArrowPathIcon,
  BugAntIcon,
} from "@heroicons/react/24/outline"

const SUGGESTIONS = [
  { icon: MagnifyingGlassIcon, label: "Explore and understand code" },
  { icon: WrenchScrewdriverIcon, label: "Build a new feature, app, or tool" },
  { icon: ArrowPathIcon, label: "Review code and suggest changes" },
  { icon: BugAntIcon, label: "Fix issues and failures" },
] as const

export function EmptyChat({
  workspaceName,
  onPick,
}: {
  workspaceName: string
  onPick: (text: string) => void
}) {
  return (
    <div className="chunky-empty">
      <img className="chunky-empty-art" src="/chunky-thinker.png" alt="" />
      <h1 className="chunky-empty-title">
        What are we building in {workspaceName}
        <span className="chunky-brand-dot">?</span>
      </h1>
      <p className="chunky-empty-sub">
        Big hands, careful with your code. Chunky runs against the local harness —
        same agent, tools, and sessions as the TUI.
      </p>
      <div className="chunky-suggestion-grid">
        {SUGGESTIONS.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.label}
              type="button"
              className="chunky-suggestion"
              onClick={() => onPick(s.label)}
            >
              <Icon className="chunky-suggestion-icon" style={{ width: 18, height: 18 }} />
              {s.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
