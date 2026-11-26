import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Network } from "./icons";
import { useSettingsStore } from "../stores/settingsStore";
import SelfHostedPanel from "./SelfHostedPanel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const SKIPPED_KEY = "selfHostedSetupSkipped";

export function SelfHostedSetupDialog() {
  const { t } = useTranslation();
  const {
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    selfHostedSttHeaders,
    setSelfHostedSttHeaders,
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
    meetingRemoteTranscriptionUrl,
    setMeetingRemoteTranscriptionUrl,
  } = useSettingsStore();

  const [dismissed, setDismissed] = useState(
    () => Boolean(remoteTranscriptionUrl.trim()) || localStorage.getItem(SKIPPED_KEY) === "true"
  );

  const open = !dismissed;

  const handleSaveAndContinue = () => {
    const trimmedUrl = remoteTranscriptionUrl.trim();
    if (!trimmedUrl) return;
    if (!uploadRemoteTranscriptionUrl.trim()) {
      setUploadRemoteTranscriptionUrl(trimmedUrl);
      setSelfHostedSttHeaders(
        "upload",
        selfHostedSttHeaders.dictation.map((row) => ({ ...row }))
      );
      if (remoteTranscriptionModel.trim() && !uploadRemoteTranscriptionModel.trim()) {
        setUploadRemoteTranscriptionModel(remoteTranscriptionModel.trim());
      }
    }
    if (!meetingRemoteTranscriptionUrl.trim()) {
      setMeetingRemoteTranscriptionUrl(trimmedUrl);
    }
    localStorage.setItem(SKIPPED_KEY, "true");
    setDismissed(true);
  };

  const handleSkip = () => {
    localStorage.setItem(SKIPPED_KEY, "true");
    setDismissed(true);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleSkip()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="w-4 h-4 text-primary" />
            {t("settingsPage.transcription.modes.selfHosted")}
          </DialogTitle>
          <DialogDescription>
            {t("settingsPage.transcription.modes.selfHostedDesc")}
          </DialogDescription>
        </DialogHeader>

        <SelfHostedPanel
          service="transcription"
          url={remoteTranscriptionUrl}
          onUrlChange={setRemoteTranscriptionUrl}
          model={remoteTranscriptionModel}
          onModelChange={setRemoteTranscriptionModel}
          headers={selfHostedSttHeaders.dictation}
          onHeadersChange={(rows) => setSelfHostedSttHeaders("dictation", rows)}
        />

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" size="sm" onClick={handleSkip}>
            {t("common.skip", "Skip for now")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!remoteTranscriptionUrl.trim()}
            onClick={handleSaveAndContinue}
          >
            {t("common.continue", "Save & Continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
