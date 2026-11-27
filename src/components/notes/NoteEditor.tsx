import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RichTextEditor } from "../ui/RichTextEditor";
import NoteRecordControl from "./NoteRecordControl";
import { Button } from "../ui/button";
import { Download, FolderOpen } from "../icons";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import type { NoteItem, FolderItem } from "../../types/electron";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";

interface NoteEditorProps {
  note: NoteItem;
  onTitleChange: (sourceNoteId: number, title: string) => void;
  onContentChange: (sourceNoteId: number, content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  recordingStartedAt?: number | null;
  readMicLevel?: () => number;
  recordingAllowed?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onExportNote?: (format: "md" | "txt") => void;
  onExportTranscript?: (format: "txt" | "srt" | "json" | "md") => void;
  // Existing summaries and transcripts remain readable/editable as local data.
  enhancement?: {
    content: string;
    isStale: boolean;
    onChange: (id: number, content: string) => void;
  };
  folderName?: string | null;
  folders?: FolderItem[];
  onMoveToFolder?: (noteId: number, folderId: number) => void;
  onCreateFolderAndMove?: (noteId: number, folderName: string) => void;
}

export default function NoteEditor({
  note,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  recordingStartedAt,
  readMicLevel,
  recordingAllowed = true,
  onStartRecording,
  onStopRecording,
  onExportNote,
  onExportTranscript,
  enhancement,
  folderName,
  folders,
  onMoveToFolder,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"notes" | "summary" | "transcript">("notes");
  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== note.title)
      titleRef.current.textContent = note.title || "";
  }, [note.id, note.title]);
  return (
    <div className="@container/note-editor flex h-full min-h-0 flex-1 flex-col">
      <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-5 pt-5 pb-3")}>
        <div
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          dir="auto"
          role="textbox"
          aria-label={t("notes.editor.noteTitle")}
          data-placeholder={t("notes.editor.untitled")}
          className="text-3xl font-medium leading-tight text-foreground outline-none tracking-[-0.01em] [overflow-wrap:anywhere] empty:before:content-[attr(data-placeholder)] empty:before:text-foreground/45"
          onInput={(event) => onTitleChange(note.id, event.currentTarget.textContent || "")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            document.execCommand(
              "insertText",
              false,
              event.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ")
            );
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {folders && onMoveToFolder && (
            <label className="inline-flex items-center gap-1.5">
              <FolderOpen size={14} />
              <select
                aria-label={t("notes.editor.noFolder")}
                value={note.folder_id ?? ""}
                className="max-w-48 bg-transparent text-xs outline-none"
                onChange={(event) => {
                  if (event.target.value) onMoveToFolder(note.id, Number(event.target.value));
                }}
              >
                {!note.folder_id && (
                  <option value="">{folderName || t("notes.editor.noFolder")}</option>
                )}
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="ms-auto" aria-live="polite">
            {isSaving ? t("notes.editor.saving") : ""}
          </span>
          {onExportNote && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={t("notes.editor.export")}>
                  <Download size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onExportNote("md")}>Markdown</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExportNote("txt")}>Text</DropdownMenuItem>
                {note.transcript && onExportTranscript && (
                  <DropdownMenuItem onSelect={() => onExportTranscript("txt")}>
                    {t("notes.editor.transcriptTab")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <NoteRecordControl
            isRecording={isRecording}
            isProcessing={isProcessing}
            startedAt={recordingStartedAt}
            readLevel={readMicLevel}
            disabled={!recordingAllowed}
            onStart={onStartRecording}
            onStop={onStopRecording}
          />
        </div>
        {(enhancement || note.transcript) && (
          <div className="mt-4 flex gap-4 border-b border-border text-sm">
            <button
              className="pb-2"
              aria-pressed={view === "notes"}
              onClick={() => setView("notes")}
            >
              {t("notes.editor.notesTab")}
            </button>
            {enhancement && (
              <button
                className="pb-2"
                aria-pressed={view === "summary"}
                onClick={() => setView("summary")}
              >
                {t("notes.editor.summaryTab")}
              </button>
            )}
            {note.transcript && (
              <button
                className="pb-2"
                aria-pressed={view === "transcript"}
                onClick={() => setView("transcript")}
              >
                {t("notes.editor.transcriptTab")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "summary" && enhancement ? (
          <RichTextEditor
            key={`${note.id}:summary`}
            value={enhancement.content}
            onChange={(content) => enhancement.onChange(note.id, content)}
          />
        ) : view === "transcript" && note.transcript ? (
          <RichTextEditor
            key={`${note.id}:transcript`}
            value={
              parseTranscriptSegments(note.transcript)
                .map((segment) => segment.text)
                .join("\n\n") || note.transcript
            }
            disabled
          />
        ) : (
          <RichTextEditor
            key={`${note.id}:notes`}
            value={note.content}
            onChange={(content) => onContentChange(note.id, content)}
            placeholder={t("notes.editor.startWriting")}
          />
        )}
      </div>
    </div>
  );
}
