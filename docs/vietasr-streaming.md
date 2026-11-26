# VietASR dictation streaming

New installations default to `https://stt.gehihi.dev/v1` with model `vietasr` for
dictation and batch uploads. Existing saved endpoints/models take precedence.
In Settings → Speech → Dictation, enable **VietASR streaming**. You can also enter
your own server's HTTP base URL, such as `http://127.0.0.1:8000/v1`.
Enable **Live Transcription Preview** to see words while speaking. The streaming
switch defaults to off; other self-hosted servers keep their batch route.
Uploads and voice-note recording remain batch transcription.

The server must implement the [VietASR v0.1.0 protocol](https://github.com/dangvansam/viet-asr/blob/v0.1.0/server/README.md#streaming--websocket).
Electron main connects to `/v1/stream` with `pipeline=stream`, 16 kHz mono PCM16
and the configured dictation HTTP headers. No OpenWhispr account or API key is
required. Public servers require HTTPS; local-network HTTP follows the existing
endpoint rules. WebSocket redirects are refused so headers stay on the selected host.

Partials replace the preview, including corrections or an empty replacement.
Stopping flushes the worklet before EOF and waits for an explicit final. Only
that final is delivered through the existing completion/paste pipeline. An empty
final is valid silence and does not trigger another transcription.

If connection/finalization fails, the retained recording is posted to the same
HTTP server using the URL, model, language and headers captured at recording start.
Changing settings mid-recording cannot redirect its fallback audio. Cancellation
closes the socket, interrupts a pending final and aborts an in-flight batch request.
Ready/final waits are bounded to 30 seconds and socket audio buffering to 2 MiB.
The fallback upload has the shared five-minute timeout. Server-side batch decoding
of WebM/Opus needs ffmpeg (included in the upstream Docker image).

## Verification

The focused regression run passed **195/195** tests. Typecheck, renderer build,
lint (existing warnings only), i18n consistency and syntax checks also passed.

Run the protocol smoke against a real server with a PCM16 mono 16 kHz speech WAV:

```powershell
node scripts/smoke-vietasr.cjs http://127.0.0.1:8000/v1 sample.wav
```

On 2026-11-26, the new adapter was tested against VietASR v0.1.0 on Windows CPU
over loopback using the existing 2.375-second VIVOS speech fixture. It produced
48 partials, first nonempty partial after 637 ms and final 72 ms after EOF.
Streaming and batch both returned `Nửa vòng trái đất hơn bảy năm.`; a separate
one-second silence session returned an empty final. These are one-run protocol
measurements, not microphone/hotkey-to-paste latency measurements.

Regressions cover the real dictation IPC closures, credentials, PCM/EOF order,
revised/empty partials, final acknowledgement, silence, timeouts, cancellation
before ready and during final, duplicate stop, settings persistence, policy and
fallback URL/header ownership. The existing matrix was corrected to exempt
self-hosted meeting routes from cloud-token requirements. The old local-silence
test now follows the minimal build's removed local gate: an unacknowledged
failed-over capture goes to the server for silence detection.

The actual dictation settings component was rendered and its streaming toggle
clicked in Orca's browser. Full Electron microphone → hotkey → target-app paste
acceptance remains to be run; the browser fixture does not validate that path.
