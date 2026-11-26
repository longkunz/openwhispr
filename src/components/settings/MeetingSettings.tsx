import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import SelfHostedPanel from "../SelfHostedPanel";
import { SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

function MeetingEchoCancellationRow() {
  const { t } = useTranslation();
  const meetingAecEnabled = useSettingsStore((s) => s.meetingAecEnabled);
  const setMeetingAecEnabled = useSettingsStore((s) => s.setMeetingAecEnabled);

  return (
    <SettingsRow
      label={t("settingsPage.transcription.aec.toggle.title")}
      description={t("settingsPage.transcription.aec.toggle.description")}
    >
      <Toggle checked={meetingAecEnabled} onChange={setMeetingAecEnabled} />
    </SettingsRow>
  );
}

export function MeetingTranscriptionPanel() {
  const {
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    setMeetingCloudTranscriptionMode,
    meetingRemoteTranscriptionUrl,
    setMeetingRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    selfHostedSttHeaders,
    setSelfHostedSttHeaders,
  } = useSettingsStore();

  useEffect(() => {
    if (meetingTranscriptionMode !== "self-hosted") {
      setMeetingTranscriptionMode("self-hosted");
      setMeetingUseLocalWhisper(false);
      setMeetingCloudTranscriptionMode("byok");
    }
  }, [
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    setMeetingCloudTranscriptionMode,
  ]);

  return (
    <div className="space-y-3">
      <SelfHostedPanel
        service="transcription"
        url={meetingRemoteTranscriptionUrl}
        onUrlChange={setMeetingRemoteTranscriptionUrl}
        model={remoteTranscriptionModel}
        onModelChange={setRemoteTranscriptionModel}
        headers={selfHostedSttHeaders.dictation}
        onHeadersChange={(rows) => setSelfHostedSttHeaders("dictation", rows)}
      />
      <MeetingSpeakerDetectionRow />
      <MeetingEchoCancellationRow />
    </div>
  );
}
