// Audio helpers for voice mode. Pure functions and classes, no DOM or Web Audio, so they run under Node tests.
// The app works on 16 kHz mono audio in 20 ms frames of 320 samples.

export const RATE = 16000;
export const FRAME = 320;
export const FRAME_MS = 20;
const RESUME_FRAMES = 3;

/** Streaming area-averaging resampler: each output sample is the mean of the input span it covers. */
export class Resampler {
	constructor(inRate, outRate = RATE) {
		this.ratio = inRate / outRate;
		this.sum = 0;
		this.weight = 0;
	}

	push(input) {
		if (this.ratio === 1) return Float32Array.from(input);
		const out = [];
		const { ratio } = this;
		for (let i = 0; i < input.length; i++) {
			const x = input[i];
			const room = ratio - this.weight;
			if (room > 1 + 1e-9) {
				this.sum += x;
				this.weight += 1;
			} else {
				// This input sample finishes the current output sample and may spill into the next one.
				const part = Math.min(1, room);
				out.push((this.sum + x * part) / ratio);
				this.sum = x * (1 - part);
				this.weight = 1 - part;
			}
		}
		return Float32Array.from(out);
	}
}

export function rms(samples) {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / (samples.length || 1));
}

export function toInt16(floats) {
	const out = new Int16Array(floats.length);
	for (let i = 0; i < floats.length; i++) {
		const v = Math.max(-1, Math.min(1, floats[i]));
		out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
	}
	return out;
}

export function concatInt16(parts) {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** 16-bit mono PCM in a canonical 44-byte-header WAV file. */
export function encodeWav(samples, rate = RATE) {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const tag = (offset, text) => [...text].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
	tag(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
	return bytes;
}

/**
 * Energy voice detector. The noise floor is the quietest frame of the last 1.5 s, so steady noise raises
 * the bar after a moment while speech, which has pauses, does not. A frame is speech when its RMS exceeds
 * max(minThreshold, floor * factor) * sensitivity.
 */
export class Vad {
	constructor({ minThreshold = 0.012, factor = 3, windowFrames = 75 } = {}) {
		this.minThreshold = minThreshold;
		this.factor = factor;
		this.windowFrames = windowFrames;
		this.sensitivity = 1;
		this.recent = [];
		this.seen = 0;
		this.voicedRun = 0;
		this.silentRun = 0;
	}

	get floor() {
		return this.recent.length ? Math.min(...this.recent) : 0;
	}

	get threshold() {
		return Math.max(this.minThreshold, this.floor * this.factor) * this.sensitivity;
	}

	update(level) {
		this.recent.push(level);
		if (this.recent.length > this.windowFrames) this.recent.shift();
		this.seen++;
		const voiced = level > this.threshold;
		if (voiced) {
			this.voicedRun++;
			this.silentRun = 0;
		} else {
			this.silentRun++;
			this.voicedRun = 0;
		}
		return voiced;
	}

	reset() {
		this.voicedRun = 0;
		this.silentRun = 0;
	}
}

/**
 * Cuts a stream of 20 ms frames into utterances. After a pause it calls onCheck with the audio so far
 * but keeps collecting, so the caller can decide later whether the turn is over (finish()) or the
 * speaker went on (resumedSince()).
 */
export class Segmenter {
	constructor({
		preRollFrames = 40,
		startCount = 3,
		startWindow = 3,
		checkSilenceFrames = 25,
		minSpeechFrames = 12,
		maxFrames = 6000,
		warmupFrames = 25,
		vad = new Vad(),
		onStart = () => {},
		onCheck = () => {},
		onDiscard = () => {},
		onLimit = () => {},
	} = {}) {
		Object.assign(this, { preRollFrames, startCount, startWindow, checkSilenceFrames, minSpeechFrames, maxFrames, warmupFrames, vad });
		Object.assign(this, { onStart, onCheck, onDiscard, onLimit });
		this.reset();
	}

	reset() {
		this.preRoll = [];
		this.flags = [];
		this.frames = null;
		this.voiced = 0;
		this.checks = 0;
		this.resumed = 0;
		this.resumes = new Map();
		this.vad.reset();
	}

	get active() {
		return this.frames !== null;
	}

	get silentFrames() {
		return this.vad.silentRun;
	}

	/** True if the speaker made sound again after the check with this sequence number. */
	resumedSince(seq) {
		return (this.resumes.get(seq) ?? 0) < this.resumed;
	}

	/** Audio collected so far, as one Int16Array. */
	audio() {
		return concatInt16(this.frames || []);
	}

	/** Ends the utterance and returns its audio. */
	finish() {
		const audio = this.audio();
		this.reset();
		return audio;
	}

	push(frame, level) {
		const voiced = this.vad.update(level);
		if (!this.frames) {
			this.preRoll.push(frame);
			if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
			this.flags.push(voiced);
			if (this.flags.length > 64) this.flags.shift();
			// Speech starts when enough of the last few frames are voiced; words have gaps, so a window beats a run.
			const recent = this.flags.slice(-this.startWindow).filter(Boolean).length;
			if (recent >= this.startCount && this.vad.seen >= this.warmupFrames) {
				this.frames = [...this.preRoll];
				this.voiced = recent;
				this.preRoll = [];
				this.onStart();
			}
			return;
		}
		this.frames.push(frame);
		if (voiced) {
			this.voiced++;
			if (this.vad.voicedRun === RESUME_FRAMES && this.checks > 0) this.resumed++;
		}
		if (this.frames.length >= this.maxFrames) {
			this.onLimit(this.finish());
			return;
		}
		if (!voiced && this.vad.silentRun === this.checkSilenceFrames) {
			if (this.voiced < this.minSpeechFrames) {
				this.reset();
				this.onDiscard();
				return;
			}
			const seq = ++this.checks;
			this.resumes.set(seq, this.resumed);
			this.onCheck(this.audio(), seq);
		}
	}
}
