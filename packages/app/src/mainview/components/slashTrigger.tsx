// The composer's `/` command menu — a ChatComposerTrigger alongside the
// `@`-mention one. Picking an entry inserts the command text (arg commands get
// a trailing space); execution happens on submit, where App.tsx routes known
// commands to the server instead of sending them as chat (see lib/commands.ts).
// The trigger only fires when `/` starts a word, so file paths never open it.
//
// Beyond the static builtins, every SAVED MODE doubles as a direct slash
// command (typing /fire applies the "fire" mode). Those entries are appended
// live from the app's modes state — deduped against builtins, which always win.
import { CommandLineIcon } from "@heroicons/react/24/outline"
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat"
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead"
import type { ModeInfo } from "@chunky/protocol"
import { prettyModel } from "../lib/api"
import { SLASH_COMMANDS, type SlashCommand } from "../lib/commands"

type CommandItem = SearchableItem<SlashCommand>

const BUILTIN_ITEMS: CommandItem[] = SLASH_COMMANDS.map((cmd) => ({
  id: cmd.name,
  label: cmd.name,
  auxiliaryData: cmd,
}))

// Lowercased builtin names ("/model", …) so a mode of the same name is dropped
// — builtin slash commands always take precedence over a like-named mode.
const BUILTIN_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name.toLowerCase()))

/** Saved modes as `/<name>` command entries (e.g. /fire · Apply mode · Sonnet).
 *  Selecting one inserts "/<name>" with NO trailing space — it applies on submit
 *  with no args. Deduped against builtins. */
function modeItems(modes: ModeInfo[]): CommandItem[] {
  return modes
    .filter((m) => !BUILTIN_NAMES.has(`/${m.name.toLowerCase()}`))
    .map((m) => {
      const cmd: SlashCommand = {
        name: `/${m.name}`,
        description: `Apply mode · ${prettyModel(m.model)}`,
        insert: `/${m.name}`,
      }
      return { id: `mode:${m.name}`, label: cmd.name, auxiliaryData: cmd }
    })
}

// Substring match on the label, mirroring createStaticSource's default filter
// so builtins behave exactly as before.
function filterItems(items: CommandItem[], query: string): CommandItem[] {
  const lower = query.toLowerCase().trim()
  if (lower === "") return items
  return items.filter((item) => item.label.toLowerCase().includes(lower))
}

export interface SlashTriggerOptions {
  /** Read the latest saved modes (live, so /mode save|rm reflect immediately). */
  getModes?: () => ModeInfo[]
  /** Kick a modes refetch when the menu opens, to keep the list fresh. */
  refreshModes?: () => void
}

export function createSlashTrigger(options: SlashTriggerOptions = {}): ChatComposerTrigger {
  const allItems = (): CommandItem[] => [...BUILTIN_ITEMS, ...modeItems(options.getModes?.() ?? [])]
  const source: SearchSource<CommandItem> = {
    search: (query) => filterItems(allItems(), query),
    bootstrap: () => {
      // Opening the menu is a good moment to refresh (cheap; deduped server-side).
      options.refreshModes?.()
      return allItems()
    },
  }
  return {
    character: "/",
    searchSource: source,
    onSelect: (item) => (item as CommandItem).auxiliaryData?.insert ?? `${item.label} `,
    renderItem: (item) => {
      const cmd = (item as CommandItem).auxiliaryData
      return (
        <span className="chunky-mention-item">
          <CommandLineIcon className="chunky-mention-icon" aria-hidden="true" />
          <span className="chunky-mention-path">{item.label}</span>
          {cmd ? <span className="chunky-command-desc"> — {cmd.description}</span> : null}
        </span>
      )
    },
    emptySearchResultsText: "No matching command",
    menuLabel: "Commands",
  }
}
