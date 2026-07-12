// The composer's `/` command menu — a static ChatComposerTrigger alongside the
// `@`-mention one. Picking an entry inserts the command text (arg commands get
// a trailing space); execution happens on submit, where App.tsx routes known
// commands to the server instead of sending them as chat (see lib/commands.ts).
// The trigger only fires when `/` starts a word, so file paths never open it.
import { CommandLineIcon } from "@heroicons/react/24/outline"
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat"
import type { SearchableItem } from "@astryxdesign/core/Typeahead"
import { createStaticSource } from "@astryxdesign/core/Typeahead"
import { SLASH_COMMANDS, type SlashCommand } from "../lib/commands"

type CommandItem = SearchableItem<SlashCommand>

const ITEMS: CommandItem[] = SLASH_COMMANDS.map((cmd) => ({
  id: cmd.name,
  label: cmd.name,
  auxiliaryData: cmd,
}))

export function createSlashTrigger(): ChatComposerTrigger {
  return {
    character: "/",
    searchSource: createStaticSource(ITEMS),
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
