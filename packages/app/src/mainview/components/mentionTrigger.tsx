import { DocumentIcon, FolderIcon } from "@heroicons/react/24/outline"
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat"
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead"
import { searchFiles, type FileSearchItem } from "../lib/api"

/** SearchableItem carrying the raw FFF hit so onSelect/renderItem can read kind + path. */
type FileItem = SearchableItem<FileSearchItem>

/** Workspace-relative path with a single trailing slash for directories. The
 *  server usually already appends it, so we add one only when it's missing. */
function displayPath(hit: FileSearchItem): string {
  if (hit.kind !== "directory" || hit.path.endsWith("/")) return hit.path
  return hit.path + "/"
}

function toItem(hit: FileSearchItem): FileItem {
  return {
    // path is unique within the workspace; kind-prefix guards a file/dir name clash.
    id: `${hit.kind}:${hit.path}`,
    label: displayPath(hit),
    auxiliaryData: hit,
  }
}

/**
 * Backs the composer's `@`-mention menu with the server's FFF file search.
 *
 * `useTriggerMenu` cancels the previous search before each new one, and also
 * probes `search("")` to detect async — so requests must be cancellable and
 * must never reject (a discarded probe promise would otherwise be an unhandled
 * rejection). We abort the in-flight request on every new call and swallow all
 * errors (including AbortError) to an empty list.
 */
function createFileSearchSource(baseUrl: string, repoId?: string | null): SearchSource<FileItem> {
  let controller: AbortController | null = null

  const run = async (query: string): Promise<FileItem[]> => {
    controller?.abort()
    const ac = new AbortController()
    controller = ac
    try {
      const hits = await searchFiles(baseUrl, query, ac.signal, 12, repoId)
      return hits.map(toItem)
    } catch {
      return [] // includes AbortError from a superseded keystroke
    }
  }

  return {
    search: (query) => run(query),
    bootstrap: () => run(""),
    cancel: () => controller?.abort(),
  }
}

/**
 * Build the `@`-mention trigger for a repo's Chunky server. Selecting a hit
 * inserts `@path` as plain text (with a trailing space and a `/` for dirs) so
 * the serialized message carries an explicit mention token — the same contract
 * the TUI sends, which the harness expands into file context.
 */
export function createMentionTrigger(baseUrl: string, repoId?: string | null): ChatComposerTrigger {
  return {
    character: "@",
    searchSource: createFileSearchSource(baseUrl, repoId),
    onSelect: (item) => {
      const hit = (item as FileItem).auxiliaryData
      return `@${hit ? displayPath(hit) : item.label} `
    },
    renderItem: (item) => {
      const hit = (item as FileItem).auxiliaryData
      const Icon = hit?.kind === "directory" ? FolderIcon : DocumentIcon
      return (
        <span className="chunky-mention-item">
          <Icon className="chunky-mention-icon" aria-hidden="true" />
          <span className="chunky-mention-path">{hit ? displayPath(hit) : item.label}</span>
        </span>
      )
    },
    emptySearchResultsText: "No files match",
    loadingText: "Searching files…",
    menuLabel: "Files",
  }
}
