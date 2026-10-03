import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME, RATE, Resampler, Segmenter, Vad, concatInt16, encodeWav, rms, toInt16 } from "../public/pcm.js";
import { parseWav } from "../src/voice.js";

const sine = (hz, seconds, rate, amp = 0.3) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

function frames(level, count) {
	return Array.from({ length: count }, (_, i) => ({ frame: new Int16Array(FRAME).fill(i), level }));
}

test("Resampler: 48 kHz and 44.1 kHz inputs come out at 16 kHz with the tone intact", () => {
	for (const rate of [48000, 44100, 32000, 16000]) {
		const out = new Resampler(rate).push(sine(440, 1, rate));
		assert.ok(Math.abs(out.length - RATE) <= 1, `${rate}: ${out.length}`);
		// A 440 Hz tone is far below the filter's cutoff, so its level survives (0.3 / sqrt(2) = 0.212).
		assert.ok(Math.abs(rms(out.subarray(100)) - 0.212) < 0.01, `${rate}: ${rms(out.subarray(100))}`);
	}
});

test("Resampler: chunked input gives the same samples as one call", () => {
	const input = sine(300, 0.5, 44100);
	const whole = new Resampler(44100).push(input);
	const r = new Resampler(44100);
	const parts = [];
	for (let i = 0; i < input.length; i += 512) parts.push(r.push(input.subarray(i, i + 512)));
	const joined = Float32Array.from(parts.flatMap((p) => [...p]));
	assert.equal(joined.length, whole.length);
	for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(joined[i] - whole[i]) < 1e-6);
});

test("Resampler: content above the new Nyquist rate is attenuated, not folded back at full level", () => {
	const out = new Resampler(48000).push(sine(15000, 0.5, 48000, 0.5));
	assert.ok(rms(out) < 0.15, `rms ${rms(out)}`);
});

test("toInt16 clamps and encodeWav writes a 16 kHz mono PCM file the Worker accepts", () => {
	assert.deepEqual([...toInt16(Float32Array.of(0, 1, -1, 2, -2, 0.5))], [0, 32767, -32768, 32767, -32768, 16384]);
	const pcm = toInt16(sine(200, 0.25, RATE));
	const wav = encodeWav(pcm);
	assert.equal(wav.length, 44 + pcm.length * 2);
	const parsed = parseWav(wav);
	assert.equal(parsed.samples, pcm.length);
	assert.equal(parsed.view.getInt16(2 * 100, true), pcm[100]);
	assert.deepEqual([...concatInt16([Int16Array.of(1, 2), Int16Array.of(3)])], [1, 2, 3]);
});

test("Vad: steady noise stops counting as speech once the floor catches up, and speech still does", () => {
	const vad = new Vad();
	for (let i = 0; i < 80; i++) vad.update(0.02);
	assert.ok(vad.threshold > 0.05, `threshold ${vad.threshold}`);
	assert.equal(vad.update(0.02), false);
	assert.equal(vad.update(0.2), true);
	assert.equal(vad.update(0.001), false);
	assert.ok(vad.threshold <= 0.0121, "a quiet frame brings the bar straight back down");
});

test("Vad: speech with short dips keeps a low floor", () => {
	const vad = new Vad();
	for (let i = 0; i < 300; i++) vad.update(i % 10 < 8 ? 0.15 : 0.004);
	assert.ok(vad.threshold < 0.02, `threshold ${vad.threshold}`);
});

function run(seg, steps) {
	for (const [level, count] of steps) for (const f of frames(level, count)) seg.push(f.frame, f.level);
}

function makeSegmenter(extra = {}) {
	const events = [];
	const seg = new Segmenter({
		warmupFrames: 0,
		onStart: () => events.push("start"),
		onCheck: (audio, seq) => events.push(["check", seq, audio.length / FRAME]),
		onDiscard: () => events.push("discard"),
		onLimit: (audio) => events.push(["limit", audio.length / FRAME]),
		...extra,
	});
	return { seg, events };
}

test("Segmenter: speech starts after 60 ms, with 400 ms of lead-in, and a check follows 500 ms of silence", () => {
	const { seg, events } = makeSegmenter();
	run(seg, [[0.001, 50], [0.2, 50], [0.001, 30]]);
	assert.equal(events[0], "start");
	// 40 pre-roll frames (the last 37 quiet ones plus the 3 that confirmed speech) + the 47 speech frames after them + 25 silent
	assert.deepEqual(events[1], ["check", 1, 40 + 47 + 25]);
	assert.equal(events.length, 2);
	assert.equal(seg.active, true);
});

test("Segmenter: a pause then more speech is reported as resumed, and a later check is numbered 2", () => {
	const { seg, events } = makeSegmenter();
	run(seg, [[0.001, 30], [0.2, 30], [0.001, 25]]);
	assert.equal(events[1][1], 1);
	assert.equal(seg.resumedSince(1), false);
	run(seg, [[0.001, 5], [0.2, 20]]);
	assert.equal(seg.resumedSince(1), true);
	run(seg, [[0.001, 25]]);
	assert.equal(events.at(-1)[1], 2);
	assert.equal(seg.resumedSince(2), false);
	const audio = seg.finish();
	assert.ok(audio.length > FRAME * 100);
	assert.equal(seg.active, false);
});

test("Segmenter: a one-frame blip after a check does not count as the speaker resuming", () => {
	const { seg } = makeSegmenter();
	run(seg, [[0.001, 30], [0.2, 30], [0.001, 25], [0.3, 1], [0.001, 10]]);
	assert.equal(seg.resumedSince(1), false);
});

test("Segmenter: a click shorter than the minimum speech is discarded", () => {
	const { seg, events } = makeSegmenter();
	run(seg, [[0.001, 30], [0.2, 4], [0.001, 40]]);
	assert.deepEqual(events, ["start", "discard"]);
	assert.equal(seg.active, false);
});

test("Segmenter: talk-over settings ignore short sounds and quiet murmurs, and accept speech with word gaps", () => {
	const { seg, events } = makeSegmenter();
	seg.startCount = 12;
	seg.startWindow = 25;
	seg.vad.sensitivity = 1.8;
	run(seg, [[0.001, 20], [0.02, 30], [0.001, 10]]);
	assert.deepEqual(events, [], "0.02 is speech normally but below 1.8x the threshold");
	run(seg, [[0.2, 10], [0.001, 30]]);
	assert.deepEqual(events, [], "10 voiced frames is a cough, not speech");
	for (let i = 0; i < 10; i++) run(seg, [[0.2, 2], [0.001, 1]]);
	assert.deepEqual(events, ["start"], "two voiced frames in three, like speech with word gaps");
});

test("Segmenter: the start of a phrase that triggers late is still in the audio", () => {
	const { seg, events } = makeSegmenter();
	seg.startCount = 12;
	seg.startWindow = 25;
	run(seg, [[0.001, 30]]);
	for (let i = 0; i < 12; i++) run(seg, [[0.2, 2], [0.001, 1]]);
	assert.equal(events[0], "start");
	// 24 voiced-pattern frames have been heard when it triggers; all of them fit inside the 40-frame lead-in
	assert.ok(seg.audio().length / FRAME >= 24);
});

test("Segmenter: an utterance is cut off at the length limit", () => {
	const { seg, events } = makeSegmenter({ maxFrames: 100 });
	run(seg, [[0.001, 30], [0.2, 150]]);
	assert.equal(events[0], "start");
	assert.deepEqual(events[1], ["limit", 100]);
});

test("Segmenter: nothing starts during the warm-up, so the noise floor is known first", () => {
	const { seg, events } = makeSegmenter({ warmupFrames: 25 });
	run(seg, [[0.2, 20]]);
	assert.deepEqual(events, []);
	run(seg, [[0.001, 30], [0.2, 10]]);
	assert.equal(events[0], "start");
});
