import { useCallback, useEffect, useRef, useState } from "react";
import { registerControlPanelReleaseGuard } from "../utils/controlPanelRelease";
import { useTranslation } from "react-i18next";
import { buildApiUrl } from "../config/constants";
import { requestSelfHostedBatch } from "../helpers/selfHostedBatchRequest.js";
import { selfHostedSttRequest } from "../helpers/selfHostedSttHeaders.js";
import { getSettings } from "../stores/settingsStore";
import { analyserRms } from "../utils/audioLevel";
import { getBaseLanguageCode } from "../utils/languageSupport";
import { useToast } from "../components/ui/useToast";

export function useVoiceNoteRecorder(
  onTranscribed: (noteId: number, text: string) => void | Promise<void>
) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [recordingNoteId, setRecordingNoteId] = useState<number | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const startGenerationRef = useRef(0);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
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
    mountedRef.current = true;
    const releaseGuard = registerControlPanelReleaseGuard(() => !busyRef.current);
    return () => {
      releaseGuard();
      mountedRef.current = false;
      busyRef.current = false;
      startGenerationRef.current += 1;
      transcriptionAbortRef.current?.abort();
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      stopTracks();
    };
  }, [stopTracks]);

  const getMicLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    return analyserRms(analyser, levelBufRef);
  }, []);

  const transcribeAudioBlob = useCallback(
    async (noteId: number, blob: Blob, signal: AbortSignal) => {
      const state = getSettings();
      const endpoint = (
        state.remoteTranscriptionUrl ||
        state.meetingRemoteTranscriptionUrl ||
        ""
      ).trim();
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

      const language = getBaseLanguageCode(state.preferredLanguage);
      const { headers, redirect } = selfHostedSttRequest(state.selfHostedSttHeaders?.dictation, {});
      const response = await requestSelfHostedBatch({
        endpoint: buildApiUrl(endpoint, "/audio/transcriptions"),
        audio: blob,
        fileName: `voice-note.${ext}`,
        headers,
        redirect,
        model: state.remoteTranscriptionModel?.trim() || undefined,
        language: language && language !== "auto" ? language : undefined,
        signal,
      });
      if (response.type === "opaqueredirect") throw new Error("Self-hosted redirect refused");
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const data = JSON.parse((await response.text()) || "{}") as { text?: unknown };
      signal.throwIfAborted();
      if (!mountedRef.current) return;

      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (text) {
        await onTranscribedRef.current(noteId, text);
      }
    },
    [t, toast]
  );

  const startRecording = useCallback(
    async (noteId: number) => {
      if (!mountedRef.current || busyRef.current) return;

      const state = getSettings();
      const endpoint = (
        state.remoteTranscriptionUrl ||
        state.meetingRemoteTranscriptionUrl ||
        ""
      ).trim();
      if (!endpoint) {
        toast({
          title: t("settingsPage.transcription.modes.selfHosted"),
          description: t("settingsPage.transcription.modes.selfHostedDesc"),
          variant: "destructive",
        });
        return;
      }

      busyRef.current = true;
      const generation = ++startGenerationRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!mountedRef.current || generation !== startGenerationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
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

        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };

        recorder.onstop = async () => {
          if (!mountedRef.current) return;
          const targetNoteId = activeNoteIdRef.current;
          const chunks = chunksRef.current;
          chunksRef.current = [];
          mediaRecorderRef.current = null;
          stopTracks();
          setIsRecording(false);
          setRecordingNoteId(null);
          setRecordingStartedAt(null);

          if (!targetNoteId || chunks.length === 0) {
            busyRef.current = false;
            return;
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size === 0) {
            busyRef.current = false;
            return;
          }

          setIsProcessing(true);
          const controller = new AbortController();
          transcriptionAbortRef.current = controller;
          try {
            await transcribeAudioBlob(targetNoteId, blob, controller.signal);
          } catch (error) {
            if (!mountedRef.current || controller.signal.aborted) return;
            toast({
              title: t("common.error", "Error"),
              description: error instanceof Error ? error.message : String(error),
              variant: "destructive",
            });
          } finally {
            transcriptionAbortRef.current = null;
            busyRef.current = false;
            if (mountedRef.current) setIsProcessing(false);
          }
        };

        recorder.start(250);
        setRecordingStartedAt(Date.now());
        setRecordingNoteId(noteId);
        setIsRecording(true);
      } catch (error) {
        if (!mountedRef.current || generation !== startGenerationRef.current) return;
        busyRef.current = false;
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
    [stopTracks, t, toast, transcribeAudioBlob]
  );

  const stopRecording = useCallback(async () => {
    startGenerationRef.current += 1;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      busyRef.current = false;
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
