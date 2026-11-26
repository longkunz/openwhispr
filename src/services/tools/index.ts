import { productHelpTools } from "./productHelpTools";
import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { createGetNoteTool } from "./getNoteTool";
import { createCreateNoteTool } from "./createNoteTool";
import { createUpdateNoteTool } from "./updateNoteTool";
import { createListFoldersTool } from "./listFoldersTool";
import type { NoteScope } from "./noteScope";
import { clipboardTool } from "./clipboardTool";
import { webSearchTool } from "./webSearchTool";
import { createSnippetTool, createUpdateSnippetsTool, type SnippetActions } from "./snippetTool";
import {
  createInteractionTools,
  type InteractionToolOptions,
} from "./interactionTools";
import type { ContainerScope } from "../../types/chat";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  cloudBackupEnabled: boolean;
  /** Disabled for onboarding demos; supported normal chat surfaces default to enabled. */
  productHelpEnabled?: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  /**
   * The spaces whose notes the note tools may read or change: the active workspace's Private and
   * its teamspaces in scope (resolveAssistantScopeSpaceIds). Nothing elsewhere reaches the model.
   */
  scopeSpaceIds: number[];
  protectNotes?: NoteScope["protectNotes"];
  getWriteGuard?: NoteScope["getWriteGuard"];
  privateWorkspaceId?: string | null;
  privateCreationAllowed?: boolean;
  /** The note a note's chat is about, which that chat's tools reach wherever it is. */
  openNoteId?: number | null;
  webSearchEnabled: boolean;
  /** Live snippet access; enables the snippet tools. */
  vocabulary?: SnippetActions;
  /** Leaves out update_note, for a turn that must not change any note. */
  keepNotesUnchanged?: boolean;
  /** Present only on surfaces that can show interactions (questions, connect cards). */
  interactions?: InteractionToolOptions;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();
  if (settings.productHelpEnabled !== false)
    for (const tool of productHelpTools) registry.register(tool);

  const useCloudSearch = settings.isSignedIn && settings.cloudBackupEnabled;
  const noteScope: NoteScope = {
    spaceIds: settings.scopeSpaceIds,
    protectNotes: settings.protectNotes,
    getWriteGuard: settings.getWriteGuard,
    privateWorkspaceId: settings.privateWorkspaceId,
    privateCreationAllowed: settings.privateCreationAllowed,
    openNoteId: settings.openNoteId,
  };
  registry.register(
    createSearchNotesTool({
      useCloudSearch,
      fixedScope: settings.searchScope,
      scopeSpaceIds: noteScope.spaceIds,
      privateWorkspaceId: settings.privateWorkspaceId,
      protectNotes: settings.protectNotes,
    })
  );
  const getNoteTool = createGetNoteTool(noteScope);
  registry.register(getNoteTool);
  registry.register(createCreateNoteTool(noteScope));
  if (!settings.keepNotesUnchanged) registry.register(createUpdateNoteTool(noteScope));
  registry.register(createListFoldersTool(noteScope));
  registry.register(clipboardTool);

  if (settings.vocabulary) {
    const snippets = settings.vocabulary.getSnippets();
    if (snippets.length > 0) registry.register(createSnippetTool(snippets));
    registry.register(createUpdateSnippetsTool(settings.vocabulary));
  }

  if (settings.isSignedIn && settings.webSearchEnabled) {
    registry.register(webSearchTool);
  }

  if (settings.interactions) {
    for (const tool of createInteractionTools(settings.interactions)) registry.register(tool);
  }

  return registry;
}
