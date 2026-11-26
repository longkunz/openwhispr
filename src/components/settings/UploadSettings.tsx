import { useEffect } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import SelfHostedPanel from "../SelfHostedPanel";

export function UploadTranscriptionPanel() {
  const {
    uploadTranscriptionMode,
    setUploadTranscriptionMode,
    setUploadUseLocalWhisper,
    setUploadCloudTranscriptionMode,
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
    selfHostedSttHeaders,
    setSelfHostedSttHeaders,
  } = useSettingsStore();

  useEffect(() => {
    if (uploadTranscriptionMode !== "self-hosted") {
      setUploadTranscriptionMode("self-hosted");
      setUploadUseLocalWhisper(false);
      setUploadCloudTranscriptionMode("byok");
    }
  }, [
    uploadTranscriptionMode,
    setUploadTranscriptionMode,
    setUploadUseLocalWhisper,
    setUploadCloudTranscriptionMode,
  ]);

  return (
    <div className="space-y-3">
      <SelfHostedPanel
        service="transcription"
        url={uploadRemoteTranscriptionUrl}
        onUrlChange={setUploadRemoteTranscriptionUrl}
        model={uploadRemoteTranscriptionModel}
        onModelChange={setUploadRemoteTranscriptionModel}
        headers={selfHostedSttHeaders.upload}
        onHeadersChange={(rows) => setSelfHostedSttHeaders("upload", rows)}
      />
    </div>
  );
}
