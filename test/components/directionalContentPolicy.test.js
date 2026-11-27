const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dynamic prose and identity values keep their own direction", () => {
  const expectations = [
    [
      "src/components/dictation/LiveTranscriptPanel.tsx",
      /<p\s+dir="auto"[\s\S]*?\{shimmerParts\.settled\}/,
    ],
    ["src/components/ui/TranscriptionItem.tsx", /<p\s+dir="auto"[\s\S]*?\{item\.text\}/],
    ["src/components/ui/TranscriptionItem.tsx", /<p\s+dir="auto"[^>]*>\s*\{rawText\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{transcript\.text\}/],
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayName\}\s*<\/span>/,
    ],
    ["src/components/notes/SpacesTree.tsx", /<span\s+dir="auto"[^>]*>\s*\{title\}\s*<\/span>/],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*<HighlightMatch\s+text=\{member\.name \|\| member\.email\}/,
    ],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{request\.name \?\? request\.email\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{downloadProgress\.title\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{folderPathLabel\(f, folders, t\)\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its content-direction policy`);
  }

  const treeContainerLabels = source("src/components/notes/SpacesTree.tsx").match(
    /<span\s+dir="auto"[^>]*>[\s\S]*?\{displayName\}\s*<\/span>/g
  );
  assert.equal(
    treeContainerLabels?.length,
    2,
    "space and localized folder labels must both detect their content direction"
  );
});

test("technical output values remain LTR inside an Arabic document", () => {
  const expectations = [
    ["src/components/DeveloperSection.tsx", /<code\s+dir="ltr"[\s\S]*?\{logPath\}/],
    [
      "src/components/TestConnectionButton.tsx",
      /<code\s+dir="ltr"[^>]*>\s*\{errorInfo\.copyCommand\}/,
    ],
    ["src/components/ui/TechnicalErrorDetails.tsx", /<pre\s+dir="ltr"[\s\S]*?\{text\}/],
    ["src/components/ui/NixOsPasteInfo.tsx", /<div\s+dir="ltr"[\s\S]*?<pre/],
    ["src/components/ui/CopyableCommand.tsx", /<div\s+dir="ltr"[\s\S]*?\{command\}/],
    [
      "src/components/settings/WorkspaceBillingCard.tsx",
      /<span\s+dir="ltr"[^>]*>\s*\{seatsUsed\} \/ \{seatsTotal\}/,
    ],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<bdi dir="ltr">\s*<HighlightMatch text=\{member\.email\}/,
    ],
    [
      "src/components/settings/WorkspaceInvitationsTab.tsx",
      /<bdi dir="ltr">\{invitation\.email\}<\/bdi>/,
    ],
    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.bedrockRegion\}/,
    ],
    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.vertexLocation\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*font-medium[^>]*>\s*\{file\.name\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*max-w-sm[^>]*>\s*\{file\.name\}/,
    ],
    ["src/components/ui/SidebarModal.tsx", /<span\s+dir="ltr"[\s\S]*?v\{version\}/],
    ["src/components/ui/ModelCardList.tsx", /<span\s+dir="ltr"[\s\S]*?\{model\.label\}/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its LTR technical-output isolation`);
  }
});

test("localized sentences isolate technical interpolations without changing word order", () => {
  const expectations = [
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?hyprlandConfigWriteWarningDescription[\s\S]*?value=\{hyprlandConfigStatus\.path\}/,
    ],
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?resetToDefault[\s\S]*?value=\{formatHotkeyLabel\(effectiveDefaultHotkey\)\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    const text = source(file);
    assert.match(text, pattern, `${file} lost a bidi-isolated technical interpolation`);
    assert.match(text, /BIDI_VALUE_TOKEN/, `${file} must interpolate with the stable marker`);
  }
});

test("direction-sensitive transient motion mirrors in RTL", () => {
  assert.match(
    source("src/components/dictation/LiveTranscriptPanel.tsx"),
    /pointer-events-none translate-x-2 rtl:-translate-x-2 opacity-0/,
    "LiveTranscriptPanel controls must retreat toward the document end"
  );
});

test("user-authored names and previews detect direction at their display boundary", () => {
  const expectations = [
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{conv\.title\}/],
    [
      "src/components/CommandSearch.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{conv\.last_message\.slice\(0, 90\)\}/,
    ],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(scopeSpace\)\}/],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(space\)\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{target\.label\}/],
    ["src/components/chat/ConversationItem.tsx", /<p\s+dir="auto"[^>]*>\s*\{title\}/],
    ["src/components/chat/ConversationItem.tsx", /<span\s+dir="auto"[^>]*>\s*\{sourceNote\.title/],
    ["src/components/chat/SourceNoteBar.tsx", /<span\s+dir="auto"[^>]*>\s*\{title\}/],
    [
      "src/components/chat/ConversationItem.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{conversation\.preview\}/,
    ],
    ["src/components/chat/ChatMessage.tsx", /<p\s+dir="auto"[^>]*>\s*\{title\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{speakerLabel\}/,
    ],
    ["src/components/notes/MeetingTranscriptChat.tsx", /<span\s+dir="auto"[^>]*>\s*\{text\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{isYouSpeakerName\(segment\.suggestedName![^}]*\?\s*recorderLabel\s*:\s*segment\.suggestedName\}/,
    ],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayLabel\}/,
    ],
    ["src/components/notes/CreateSpaceDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{item\.name\}/],
    ["src/components/notes/CreateSpaceDialog.tsx", /<p\s+dir="auto"[^>]*>\s*\{workspace\.name\}/],
    ["src/components/notes/SpaceMembersTable.tsx", /<span\s+dir="auto"[^>]*>\s*\{member\.name\}/],
    ["src/components/notes/SpaceMembersTable.tsx", /<span\s+dir="auto"[^>]*>\s*\{team\.name\}/],
    ["src/components/notes/SpaceMembersTable.tsx", /<span\s+dir="auto"[^>]*>\s*\{row\.teamName\}/],
    // The page shows the name only in its input.
    [
      "src/components/settings/WorkspaceGeneralSection.tsx",
      /<Input\s+id=\{nameId\}\s+dir="auto"\s+value=\{name\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost a dynamic-content direction boundary`);
  }
});
