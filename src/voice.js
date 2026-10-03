// Voice endpoints. The app records 16 kHz mono 16-bit PCM and uploads it as a WAV file.
//   POST /api/voice/transcribe  WAV                -> { text }                     Nova-3
//   POST /api/voice/turn        WAV                -> { complete, probability }    Smart Turn v2
//   POST /api/voice/speak       { text, voice }    -> audio/mpeg                   Aura-2
//   GET  /api/voices                               -> voice list and limits

import { HttpError, NO_STORE, aiOptions, json, readBytes } from "./http.js";
import { DEFAULT_VOICE, VOICES, VOICE_MODELS, voiceById } from "./voices.js";

export const STT_MODEL = "@cf/deepgram/nova-3";
export const TURN_MODEL = "@cf/pipecat-ai/smart-turn-v2";
export const SAMPLE_RATE = 16000;
export const MAX_UTTERANCE_SECONDS = 120;
// Smart Turn v2 judges the last 8 seconds of audio.
export const TURN_WINDOW_SECONDS = 8;
// Aura-2 rejects longer input with HTTP 413.
export const MAX_SPEECH_CHARS = 2000;

const MIN_UTTERANCE_SAMPLES = SAMPLE_RATE / 10;
const MAX_WAV_BYTES = 44 + MAX_UTTERANCE_SECONDS * SAMPLE_RATE * 2 + 1024;
const MAX_SPEAK_BODY = 16 * 1024;
const SPEAKABLE = /[\p{L}\p{N}]/u;

export function voiceConfig() {
	return json({
		voices: VOICES,
		default: DEFAULT_VOICE,
		sampleRate: SAMPLE_RATE,
		maxUtteranceSeconds: MAX_UTTERANCE_SECONDS,
		turnWindowSeconds: TURN_WINDOW_SECONDS,
		maxSpeechChars: MAX_SPEECH_CHARS,
	});
}

/** Returns the 16-bit PCM payload of a 16 kHz mono WAV file as a DataView plus its sample count. */
export function parseWav(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
	if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
		throw new HttpError(415, "Audio must be a WAV file.");
	}
	let format = null;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= bytes.byteLength) {
			format = { code: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
		} else if (id === "data") {
			if (!format) throw new HttpError(400, "WAV file has no format chunk.");
			if (format.code !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
				throw new HttpError(415, `Audio must be ${SAMPLE_RATE} Hz mono 16-bit PCM.`);
			}
			// Streamed WAVs can carry a size larger than the bytes present.
			const end = Math.min(body + size, bytes.byteLength);
			const samples = (end - body) >> 1;
			return { view: new DataView(bytes.buffer, bytes.byteOffset + body, samples * 2), samples };
		}
		offset = body + size + (size & 1);
	}
	throw new HttpError(400, "WAV file has no audio data.");
}

async function readWav(request) {
	const bytes = await readBytes(request, MAX_WAV_BYTES, `Audio is limited to ${MAX_UTTERANCE_SECONDS} seconds.`);
	const wav = parseWav(bytes);
	if (wav.samples < MIN_UTTERANCE_SAMPLES) throw new HttpError(400, "The recording is too short.");
	return { bytes, wav };
}

async function run(env, model, input) {
	try {
		return await env.AI.run(model, input, aiOptions(env));
	} catch (err) {
		console.error("AI.run failed", model, err);
		throw new HttpError(502, `Voice request failed: ${err?.message || String(err)}`);
	}
}

export async function transcribe(request, env) {
	const { bytes } = await readWav(request);
	// language "multi" is Deepgram's multilingual mode (English, Spanish, French, German, Hindi,
	// Russian, Portuguese, Japanese, Italian, Dutch per Cloudflare's RealtimeKit changelog).
	const out = await run(env, STT_MODEL, {
		audio: { body: new Response(bytes).body, contentType: "audio/wav" },
		language: "multi",
		smart_format: true,
	});
	const text = out?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
	if (typeof text !== "string") throw new HttpError(502, "Transcription returned an unexpected result.");
	return json({ text: text.trim() });
}

export async function turn(request, env) {
	const { wav } = await readWav(request);
	const count = Math.min(wav.samples, TURN_WINDOW_SECONDS * SAMPLE_RATE);
	const first = wav.samples - count;
	const floats = new Float32Array(count);
	for (let i = 0; i < count; i++) floats[i] = wav.view.getInt16((first + i) * 2, true) / 32768;
	const out = await run(env, TURN_MODEL, { audio: toBase64(new Uint8Array(floats.buffer)), dtype: "float32" });
	if (typeof out?.is_complete !== "boolean" || typeof out?.probability !== "number") {
		throw new HttpError(502, "Turn detection returned an unexpected result.");
	}
	return json({ complete: out.is_complete, probability: out.probability });
}

export async function speak(request, env) {
	let body;
	try {
		body = JSON.parse(new TextDecoder().decode(await readBytes(request, MAX_SPEAK_BODY, "Request too large.")));
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(400, "Body must be JSON.");
	}
	const text = typeof body?.text === "string" ? body.text.trim() : "";
	if (!SPEAKABLE.test(text)) throw new HttpError(400, "There is no text to speak.");
	if (text.length > MAX_SPEECH_CHARS) throw new HttpError(400, `Text is limited to ${MAX_SPEECH_CHARS} characters.`);
	const voice = voiceById(body.voice ?? DEFAULT_VOICE);
	if (!voice) throw new HttpError(400, "Unknown voice.");

	const stream = await run(env, VOICE_MODELS[voice.lang], { text, speaker: voice.id, encoding: "mp3" });
	return new Response(stream, { headers: { "content-type": "audio/mpeg", ...NO_STORE } });
}

function toBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}
