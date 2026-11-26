import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { selfHostedSttRequest } from "../helpers/selfHostedSttHeaders.js";
import { getSettings } from "../stores/settingsStore";
import { analyserRms } from "../utils/audioLevel";
import { getBaseLanguageCode } from "../utils/languageSupport";
import { useToast } from "../components/ui/useToast";

function buildTranscriptionUrl(rawUrl: string): string {
  const base = rawUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith("/audio/transcriptions") ? base : `${base}/audio/transcriptions`;
}

export function useVoiceNoteRecorder(onTranscribed: (noteId: number, text: string) => void) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [recordingNoteId, setRecordingNoteId] = useState<number | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const activeNoteIdRef = useRef<number | null>(null);
  const onTranscribedRef = useRef(onTranscribed);
  onTranscribedRef.current = onTranscribed;

  const stopTracks = useCallback(() => {
    analyserRef.current = null;
    levelBufRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try {
          mediaRecorderRef.current.stop();
        } catch {}
      }
      stopTracks();
    };
  }, [stopTracks]);

  const getMicLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    return analyserRms(analyser, levelBufRef);
  }, []);

  const transcribeAudioBlob = useCallback(
    async (noteId: number, blob: Blob) => {
      const state = getSettings();
      const endpoint = buildTranscriptionUrl(
        state.remoteTranscriptionUrl || state.meetingRemoteTranscriptionUrl || ""
      );
      if (!endpoint) {
        toast({
          title: t("settingsPage.transcription.modes.selfHosted"),
          description: t("settingsPage.transcription.modes.selfHostedDesc"),
          variant: "destructive",
        });
        return;
      }

      const ext = blob.type.includes("ogg")
        ? "ogg"
        : blob.type.includes("mp4")
          ? "mp4"
          : blob.type.includes("wav")
            ? "wav"
            : "webm";

      const formData = new FormData();
      formData.append("file", blob, `voice-note.${ext}`);
      if (state.remoteTranscriptionModel?.trim()) {
        formData.append("model", state.remoteTranscriptionModel.trim());
      }
      const language = getBaseLanguageCode(state.preferredLanguage);
      if (language && language !== "auto") {
        formData.append("language", language);
      }

      const { headers, redirect } = selfHostedSttRequest(state.selfHostedSttHeaders?.dictation, {});
      let data: { text?: unknown } | null = null;
      if (typeof window !== "undefined" && window.electronAPI?.proxySelfHostedTranscription) {
        const proxyResult = await window.electronAPI.proxySelfHostedTranscription({
          endpoint,
          headers,
          redirect,
          audioBuffer: await blob.arrayBuffer(),
          fileName: `voice-note.${ext}`,
          mimeType: blob.type || "audio/webm",
          model: state.remoteTranscriptionModel?.trim() || undefined,
          language: language && language !== "auto" ? language : undefined,
        });
        if (proxyResult?.fetchError) {
          throw new Error(proxyResult.fetchError.message || "Failed to connect to server");
        }
        if (!proxyResult?.ok) {
          throw new Error(proxyResult?.bodyText || `HTTP ${proxyResult?.status ?? 0}`);
        }
        data = JSON.parse(proxyResult.bodyText || "{}");
      } else {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: formData,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(errText || `HTTP ${response.status}`);
        }

        data = await response.json();
      }

      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (text) {
        onTranscribedRef.current(noteId, text);
      }
    },
    [t, toast]
  );

  const startRecording = useCallback(
    async (noteId: number) => {
      if (isRecording || isProcessing) return;

      const state = getSettings();
      const endpoint = buildTranscriptionUrl(
        state.remoteTranscriptionUrl || state.meetingRemoteTranscriptionUrl || ""
      );
      if (!endpoint) {
        toast({
          title: t("settingsPage.transcription.modes.selfHosted"),
          description: t("settingsPage.transcription.modes.selfHostedDesc"),
          variant: "destructive",
        });
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        activeNoteIdRef.current = noteId;

        try {
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          audioContextRef.current = audioCtx;
          analyserRef.current = analyser;
        } catch {}

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";

        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };

        recorder.onstop = async () => {
          const targetNoteId = activeNoteIdRef.current;
          const chunks = chunksRef.current;
          chunksRef.current = [];
          mediaRecorderRef.current = null;
          stopTracks();
          setIsRecording(false);
          setRecordingNoteId(null);
          setRecordingStartedAt(null);

          if (!targetNoteId || chunks.length === 0) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size === 0) return;

          setIsProcessing(true);
          try {
            await transcribeAudioBlob(targetNoteId, blob);
          } catch (error) {
            toast({
              title: t("common.error", "Error"),
              description: error instanceof Error ? error.message : String(error),
              variant: "destructive",
            });
          } finally {
            setIsProcessing(false);
          }
        };

        recorder.start(250);
        setRecordingStartedAt(Date.now());
        setRecordingNoteId(noteId);
        setIsRecording(true);
      } catch (error) {
        stopTracks();
        setIsRecording(false);
        setRecordingNoteId(null);
        setRecordingStartedAt(null);
        toast({
          title: t("common.error", "Error"),
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
    },
    [isProcessing, isRecording, stopTracks, t, toast, transcribeAudioBlob]
  );

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      stopTracks();
      setIsRecording(false);
      setRecordingNoteId(null);
      setRecordingStartedAt(null);
    }
  }, [stopTracks]);

  return {
    recordingNoteId,
    recordingStartedAt,
    isRecording,
    isProcessing,
    getMicLevel,
    startRecording,
    stopRecording,
  };
}
