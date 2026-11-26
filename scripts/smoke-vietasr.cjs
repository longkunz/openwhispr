// Run against a real server: node scripts/smoke-vietasr.cjs BASE_URL PCM16_MONO_16KHZ.wav
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { VietAsrStreaming } = require("../src/helpers/vietAsrStreaming");
const { buildApiUrl } = require("../src/config/constants.ts");

async function main() {
  const [baseUrl, file] = process.argv.slice(2);
  if (!baseUrl || !file)
    throw new Error("Usage: node scripts/smoke-vietasr.cjs BASE_URL PCM16_MONO_16KHZ.wav");
  const wav = fs.readFileSync(file);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Expected a WAV file");
  let pcm;
  let validFormat = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV");
    const kind = wav.toString("ascii", offset, offset + 4);
    if (kind === "fmt ")
      validFormat =
        size >= 16 &&
        wav.readUInt16LE(start) === 1 &&
        wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 16000 &&
        wav.readUInt16LE(start + 14) === 16;
    if (kind === "data") pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!pcm?.length || !validFormat) throw new Error("Use PCM16 mono at 16 kHz");
  const adapter = new VietAsrStreaming();
  let firstPartialMs = null;
  let partials = 0;
  let started;
  adapter.onPartialTranscript = (text) => {
    partials++;
    if (text.trim() && firstPartialMs === null)
      firstPartialMs = Math.round(performance.now() - started);
  };
  let final;
  let eofToFinalMs;
  try {
    await adapter.connect({ baseUrl });
    started = performance.now();
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      adapter.sendAudio(pcm.subarray(offset, offset + 1600));
      await delay(
        Math.max(0, started + Math.min(offset + 1600, pcm.length) / 32 - performance.now())
      );
    }
    const eof = performance.now();
    final = await adapter.finalize();
    eofToFinalMs = Math.round(performance.now() - eof);
  } finally {
    await adapter.disconnect();
  }
  const body = new FormData();
  body.append("file", new Blob([wav], { type: "audio/wav" }), "sample.wav");
  const response = await fetch(buildApiUrl(baseUrl, "/audio/transcriptions"), {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Batch HTTP ${response.status}`);
  const batch = await response.json();
  if (!final.text.trim() || final.text !== batch.text)
    throw new Error("Streaming and batch transcripts differ or are empty");
  const silent = new VietAsrStreaming();
  try {
    await silent.connect({ baseUrl });
    silent.sendAudio(Buffer.alloc(32000));
    if ((await silent.finalize()).text !== "") throw new Error("Silence produced text");
  } finally {
    await silent.disconnect();
  }
  process.stdout.write(
    JSON.stringify(
      {
        audioSeconds: pcm.length / 32000,
        partials,
        firstPartialMs,
        eofToFinalMs,
        final: final.text,
        batchMatches: true,
        silenceFinalEmpty: true,
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
