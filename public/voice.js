import { FRAME, FRAME_MS, RATE, Resampler, Segmenter, concatInt16, encodeWav, rms, toInt16 } from "./pcm.js";
import { createChunker } from "./speech.js";

const KEY_VOICE = "thread.voice";
const KEY_MODE = "thread.voiceMode";
// On iPhone and iPad an open microphone puts the page in a "play-and-record" audio session, which can send
// replies to the earpiece or silence them. There the microphone closes while a reply plays, unless the user
// turns talk-over on, so iOS keeps its own setting with talk-over off by default.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const KEY_TALK_OVER = IOS ? "thread.voiceTalkOver.ios" : "thread.voiceTalkOver";
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

const LANGUAGES = { en: "English", es: "Español" };
const PREVIEW = {
	en: (name) => `Hi, I'm ${name}. This is how I sound.`,
	es: (name) => `Hola, soy ${name}. Así es como sueno.`,
};
// Talking over a reply takes 240 ms of voiced frames within half a second, at 1.8x the usual threshold,
// so a cough or the phone's own echo is not enough.
const TALK_OVER = { startCount: 12, startWindow: 25, sensitivity: 1.8 };
const NORMAL = { startCount: 3, startWindow: 3, sensitivity: 1 };
// Smart Turn can say the speaker is not done; stop waiting after this much silence anyway.
const FORCE_END_FRAMES = 150;
const MIN_TAP_FRAMES = 15;

const LABELS = {
	starting: "Starting…",
	listening: "Listening",
	recording: "Listening",
	processing: "Transcribing…",
	thinking: "Thinking…",
	speaking: "Speaking",
	idle: "Tap to talk",
	micIdle: "Tap to listen",
};

// Audio Session API (Safari 17+): "playback" uses the speaker and ignores the silent switch; "auto" lets the
// browser choose, which is "play-and-record" while the microphone is open.
function setAudioSession(type) {
	try {
		if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type;
	} catch {}
}

const cap = (text) => text[0].toUpperCase() + text.slice(1);

async function errorText(res) {
	try {
		const data = await res.json();
		if (data?.error) return data.error;
	} catch {}
	return `Request failed (${res.status})`;
}

/**
 * Full-screen voice chat: microphone capture, turn detection, transcription, spoken replies and the voice picker.
 * deps: { storage, el, icon, toast, api, isAuthError, turn, stopReply, cutReply, modelName, syncModal }
 */
export function createVoice(deps) {
	const { storage, el, icon, toast, api } = deps;
	const $ = (id) => document.getElementById(id);
	const ui = {
		root: $("voice"),
		close: $("voiceClose"),
		model: $("voiceModel"),
		chip: $("voiceChip"),
		chipName: $("voiceChipName"),
		orb: $("voiceOrb"),
		state: $("voiceState"),
		hint: $("voiceHint"),
		user: $("voiceUser"),
		reply: $("voiceReply"),
		modes: $("voiceModes"),
		mute: $("voiceMute"),
		scrim: $("voiceScrim"),
		sheet: $("voiceSheet"),
		sheetClose: $("voiceSheetClose"),
		talkOver: $("voiceTalkOver"),
		filter: $("voiceFilter"),
		list: $("voiceList"),
	};
	const prefs = {
		voice: storage.get(KEY_VOICE),
		mode: storage.get(KEY_MODE) === "ptt" ? "ptt" : "hands-free",
		talkOver: IOS ? storage.get(KEY_TALK_OVER) === "1" : storage.get(KEY_TALK_OVER) !== "0",
	};
	const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
	let config = null;
	let configLoading = null;
	let filter = "en";
	let s = null;

	/* ---------- Setup ---------- */

	function loadConfig() {
		if (config) return Promise.resolve(config);
		configLoading ??= api("/api/voices")
			.then(async (res) => {
				if (!res.ok) throw new Error(await errorText(res));
				return res.json();
			})
			.then((data) => {
				config = data;
				if (!data.voices.some((v) => v.id === prefs.voice)) prefs.voice = data.default;
				return data;
			})
			.finally(() => (configLoading = null));
		return configLoading;
	}

	const voiceOf = (id) => config.voices.find((v) => v.id === id);

	async function post(path, body, type, signal) {
		const res = await api(path, { method: "POST", headers: { "content-type": type }, body, signal });
		if (!res.ok) throw new Error(await errorText(res));
		return res;
	}

	function open() {
		if (s) return;
		const Context = window.AudioContext || window.webkitAudioContext;
		if (!navigator.mediaDevices?.getUserMedia || !Context || typeof AudioWorkletNode === "undefined") {
			toast("Voice chat needs a newer browser");
			return;
		}
		let ctx;
		try {
			ctx = new Context({ latencyHint: "interactive" });
		} catch {
			toast("Couldn't start audio");
			return;
		}
		// Must happen inside the tap that opened voice mode, or iOS keeps the context suspended.
		ctx.resume().catch(() => {});
		const sess = makeSession(ctx);
		s = sess;
		ui.user.textContent = "";
		ui.reply.textContent = "";
		ui.model.textContent = deps.modelName();
		show();
		start(sess).catch((err) => fail(sess, err));
		if (!reducedMotion.matches) requestAnimationFrame(tick);
	}

	function makeSession(ctx) {
		const out = ctx.createGain();
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		out.connect(analyser);
		analyser.connect(ctx.destination);
		const sess = {
			ctx,
			out,
			analyser,
			analyserData: new Float32Array(analyser.fftSize),
			stream: null,
			source: null,
			tap: null,
			micBusy: null,
			micBlocked: false,
			nodes: [],
			resampler: null,
			pending: new Float32Array(0),
			seg: null,
			rec: null,
			forceTimer: 0,
			state: "starting",
			muted: false,
			paused: false,
			closed: false,
			micLevel: 0,
			shown: 0,
			turn: null,
			speaker: null,
			request: null,
			preview: null,
			wake: null,
			notified: false,
		};
		sess.seg = new Segmenter({
			onStart: () => {
				if (sess.state === "thinking" || sess.state === "speaking") interrupt(sess);
				setState(sess, "recording");
			},
			onCheck: (audio, seq) => check(sess, audio, seq),
			onDiscard: () => idle(sess),
			onLimit: (audio) => submit(sess, audio),
		});
		return sess;
	}

	async function start(sess) {
		const [data] = await Promise.all([loadConfig(), sess.ctx.audioWorklet.addModule("/voice-worklet.js")]);
		if (sess.closed) return;
		sess.resampler = new Resampler(sess.ctx.sampleRate);
		sess.seg.maxFrames = Math.round((data.maxUtteranceSeconds * 1000) / FRAME_MS);
		const tap = new AudioWorkletNode(sess.ctx, "thread-tap");
		tap.port.onmessage = (e) => onSamples(sess, e.data);
		const silent = sess.ctx.createGain();
		silent.gain.value = 0;
		tap.connect(silent);
		silent.connect(sess.ctx.destination);
		sess.tap = tap;
		sess.nodes.push(tap, silent);
		// iOS can suspend or interrupt the context when the audio session changes; bring it back.
		sess.ctx.onstatechange = () => {
			if (s === sess && sess.ctx.state !== "running" && sess.ctx.state !== "closed") sess.ctx.resume().catch(() => {});
		};
		await openMic(sess);
		if (sess.closed) return;
		if (sess.ctx.state !== "running") await sess.ctx.resume();
		keepAwake(sess);
		ui.chipName.textContent = cap(prefs.voice);
		setState(sess, prefs.mode === "ptt" ? "idle" : "listening");
	}

	/* ---------- Microphone ---------- */

	// With half duplex the microphone is closed while a reply plays, so iOS plays it through the speaker.
	const halfDuplex = () => IOS && !prefs.talkOver;

	function micWanted(sess) {
		if (sess.closed || sess.state === "starting") return false;
		if (!halfDuplex()) return true;
		return !sess.paused && !sess.muted && sess.state !== "thinking" && sess.state !== "speaking";
	}

	async function openMic(sess) {
		if (sess.stream) return;
		setAudioSession("auto");
		const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
		if (sess.closed || sess.stream) {
			stream.getTracks().forEach((t) => t.stop());
			return;
		}
		sess.stream = stream;
		sess.micBlocked = false;
		sess.pending = new Float32Array(0);
		// A reopened microphone learns the room's noise floor again before speech can start.
		sess.seg.vad.recent = [];
		sess.seg.vad.seen = 0;
		stream.getAudioTracks().forEach((t) => (t.enabled = !sess.muted));
		sess.source = sess.ctx.createMediaStreamSource(stream);
		sess.source.connect(sess.tap);
		stream.getAudioTracks()[0]?.addEventListener("ended", () => {
			if (s !== sess || sess.stream !== stream) return;
			toast("The microphone stopped");
			close();
		});
	}

	function closeMic(sess) {
		const stream = sess.stream;
		if (!stream) return;
		sess.stream = null;
		try {
			sess.source?.disconnect();
		} catch {}
		sess.source = null;
		stream.getTracks().forEach((t) => t.stop());
		sess.micLevel = 0;
		if (halfDuplex()) setAudioSession("playback");
	}

	// Opens or closes the microphone to match the state; runs after every state change.
	function syncMic(sess) {
		if (sess.closed || sess.micBusy) return;
		const want = micWanted(sess);
		if (!want) {
			closeMic(sess);
			if (halfDuplex() && !sess.stream) setAudioSession("playback");
			return;
		}
		// After a refusal, wait for a tap on the orb instead of retrying on every state change.
		if (sess.stream || sess.micBlocked) return;
		sess.micBusy = openMic(sess)
			.catch((err) => {
				if (s !== sess) return;
				// Some browsers only reopen the microphone from a tap; the orb asks for one.
				sess.micBlocked = true;
				console.error("microphone reopen failed", err);
			})
			.finally(() => {
				sess.micBusy = null;
				if (s !== sess) return;
				render();
				if (!sess.micBlocked && micWanted(sess) !== Boolean(sess.stream)) syncMic(sess);
			});
	}

	async function keepAwake(sess) {
		try {
			sess.wake = (await navigator.wakeLock?.request("screen")) || null;
		} catch {}
	}

	function fail(sess, err) {
		if (s !== sess) return;
		console.error("voice start failed", err);
		if (deps.isAuthError(err)) {
			close();
			return;
		}
		const reason =
			err?.name === "NotAllowedError"
				? "Microphone access is blocked. Allow it for this site in your browser settings."
				: err?.name === "NotFoundError"
					? "No microphone found."
					: err?.message || "Couldn't start voice chat";
		toast(reason);
		close();
	}

	function close() {
		const sess = s;
		if (!sess) return;
		interrupt(sess);
		s = null;
		sess.closed = true;
		clearTimeout(sess.forceTimer);
		stopPreview(sess);
		sess.stream?.getTracks().forEach((t) => t.stop());
		sess.stream = null;
		try {
			sess.source?.disconnect();
		} catch {}
		for (const node of sess.nodes) {
			try {
				node.disconnect();
			} catch {}
		}
		sess.ctx.close().catch(() => {});
		sess.wake?.release().catch(() => {});
		setAudioSession("auto");
		hide();
	}

	function show() {
		ui.root.inert = false;
		ui.root.classList.add("open");
		deps.syncModal();
		render();
		setTimeout(() => ui.orb.focus({ preventScroll: true }), 60);
	}

	function hide() {
		closeSheet();
		document.activeElement?.blur?.();
		ui.root.classList.remove("open");
		ui.root.inert = true;
		deps.syncModal();
	}

	/* ---------- State and display ---------- */

	function setState(sess, state) {
		if (s !== sess) return;
		sess.state = state;
		syncMic(sess);
		render();
	}

	function idle(sess) {
		if (s !== sess) return;
		sess.seg.reset();
		sess.rec = null;
		setState(sess, prefs.mode === "ptt" ? "idle" : "listening");
	}

	function render() {
		const sess = s;
		if (!sess) return;
		const ptt = prefs.mode === "ptt";
		const active = sess.state === "thinking" || sess.state === "speaking";
		const shown = sess.paused ? "idle" : sess.muted && !active && sess.state !== "starting" ? "muted" : sess.state;
		ui.orb.dataset.state = shown;
		let label = sess.paused ? "Paused" : sess.muted && shown === "muted" ? "Muted" : LABELS[sess.state];
		if (ptt && sess.state === "recording") label = "Listening… tap when done";
		const micIdle = sess.micBlocked && !sess.stream && !active && !sess.paused && !sess.muted && sess.state !== "starting";
		if (micIdle) {
			label = LABELS.micIdle;
			ui.orb.dataset.state = "idle";
		}
		ui.state.textContent = label;
		let hint = "";
		if (sess.state !== "starting" && !sess.paused) {
			if (ptt) hint = "Tap the orb to talk, then tap again to send.";
			else if (active) hint = prefs.talkOver ? "Speak any time to interrupt, or tap the orb." : "Tap the orb to interrupt.";
			else if (micIdle) hint = "The microphone paused while I spoke. Tap the orb to keep talking.";
			else if (shown === "muted") hint = "The microphone is off.";
			else hint = "Just talk. I'll answer when you pause.";
		}
		ui.hint.textContent = hint;
		ui.orb.setAttribute(
			"aria-label",
			ptt
				? sess.state === "recording"
					? "Send"
					: active
						? "Interrupt and talk"
						: "Start talking"
				: active
					? "Interrupt"
					: "Voice level",
		);
		for (const b of ui.modes.querySelectorAll(".seg")) b.setAttribute("aria-checked", String(b.dataset.mode === prefs.mode));
		ui.mute.hidden = ptt;
		ui.mute.setAttribute("aria-pressed", String(sess.muted));
		ui.mute.querySelector("span").textContent = sess.muted ? "Unmute" : "Mute";
		ui.mute.querySelector("use").setAttribute("href", sess.muted ? "#i-mic-off" : "#i-mic");
		ui.talkOver.setAttribute("aria-checked", String(prefs.talkOver));
	}

	function tick() {
		const sess = s;
		if (!sess) return;
		let target = 0;
		if (sess.state === "speaking") {
			sess.analyser.getFloatTimeDomainData(sess.analyserData);
			target = Math.min(1, rms(sess.analyserData) * 5);
		} else if (!sess.muted && !sess.paused && (sess.state === "listening" || sess.state === "recording")) {
			target = Math.min(1, sess.micLevel * 6);
		}
		sess.shown += (target - sess.shown) * 0.35;
		ui.orb.style.setProperty("--level", sess.shown.toFixed(3));
		requestAnimationFrame(tick);
	}

	/* ---------- Microphone frames ---------- */

	function onSamples(sess, block) {
		if (sess.closed) return;
		const mono = sess.resampler.push(block);
		const joined = new Float32Array(sess.pending.length + mono.length);
		joined.set(sess.pending);
		joined.set(mono, sess.pending.length);
		let at = 0;
		for (; joined.length - at >= FRAME; at += FRAME) {
			const frame = joined.subarray(at, at + FRAME);
			const level = rms(frame);
			sess.micLevel = level;
			if (sess.muted || sess.paused || sess.state === "starting") continue;
			if (prefs.mode === "ptt") {
				if (sess.rec) {
					sess.rec.push(toInt16(frame));
					if (sess.rec.length >= sess.seg.maxFrames) stopRecording(sess);
				}
			} else {
				handsFree(sess, toInt16(frame), level);
			}
		}
		sess.pending = joined.slice(at);
	}

	function handsFree(sess, pcm, level) {
		const replying = sess.state === "thinking" || sess.state === "speaking";
		if (replying && !prefs.talkOver) return;
		if (sess.state === "processing") return;
		const mode = replying ? TALK_OVER : NORMAL;
		sess.seg.startCount = mode.startCount;
		sess.seg.startWindow = mode.startWindow;
		sess.seg.vad.sensitivity = mode.sensitivity;
		sess.seg.push(pcm, level);
	}

	/* ---------- Turn taking ---------- */

	// After a pause: ask Smart Turn whether the speaker is done and transcribe what we have, in parallel.
	async function check(sess, audio, seq) {
		if (s !== sess) return;
		const tail = audio.subarray(Math.max(0, audio.length - Math.round(config.turnWindowSeconds * RATE)));
		try {
			const [turn, text] = await Promise.all([
				post("/api/voice/turn", encodeWav(tail), "audio/wav")
					.then((res) => res.json())
					.catch((err) => {
						if (deps.isAuthError(err)) throw err;
						return { complete: true };
					}),
				transcribe(audio),
			]);
			if (s !== sess || !sess.seg.active || sess.seg.resumedSince(seq)) return;
			if (!text) {
				idle(sess);
				return;
			}
			if (turn.complete) {
				begin(sess, text);
				return;
			}
			const wait = Math.max(0, FORCE_END_FRAMES - sess.seg.silentFrames) * FRAME_MS;
			clearTimeout(sess.forceTimer);
			sess.forceTimer = setTimeout(() => {
				if (s === sess && sess.seg.active && !sess.seg.resumedSince(seq)) begin(sess, text);
			}, wait);
		} catch (err) {
			problem(sess, err, "Couldn't transcribe that");
		}
	}

	async function transcribe(audio) {
		const res = await post("/api/voice/transcribe", encodeWav(audio), "audio/wav");
		return String((await res.json()).text || "").trim();
	}

	async function submit(sess, audio) {
		setState(sess, "processing");
		try {
			const text = await transcribe(audio);
			if (s !== sess) return;
			if (!text) {
				toast("I didn't catch that");
				idle(sess);
				return;
			}
			begin(sess, text);
		} catch (err) {
			problem(sess, err, "Couldn't transcribe that");
		}
	}

	function problem(sess, err, fallback) {
		if (s !== sess || err?.name === "AbortError") return;
		if (deps.isAuthError(err)) {
			close();
			return;
		}
		toast(err?.message || fallback);
		idle(sess);
	}

	function startRecording(sess) {
		if (sess.state === "thinking" || sess.state === "speaking") interrupt(sess);
		sess.rec = [];
		setState(sess, "recording");
	}

	function stopRecording(sess) {
		const frames = sess.rec;
		sess.rec = null;
		if (!frames || sess.state !== "recording") return;
		if (frames.length < MIN_TAP_FRAMES) {
			toast("Too short. Tap, speak, then tap again.");
			idle(sess);
			return;
		}
		submit(sess, concatInt16(frames));
	}

	function orbTap() {
		const sess = s;
		if (!sess || sess.paused || sess.state === "starting") return;
		sess.ctx.resume().catch(() => {});
		if (sess.micBlocked && !sess.stream) {
			sess.micBlocked = false;
			syncMic(sess);
			render();
			return;
		}
		if (prefs.mode === "ptt") {
			if (sess.state === "recording") stopRecording(sess);
			else if (sess.state === "idle" || sess.state === "thinking" || sess.state === "speaking") startRecording(sess);
		} else if (sess.state === "thinking" || sess.state === "speaking") {
			interrupt(sess);
			idle(sess);
		}
	}

	/* ---------- Replies ---------- */

	function begin(sess, text) {
		clearTimeout(sess.forceTimer);
		sess.seg.reset();
		ui.user.textContent = text;
		ui.reply.textContent = "";
		const turn = { interrupted: false, keep: 0, chunker: createChunker(), speaker: null, warned: false };
		sess.turn = turn;
		const speaker = new Speaker({
			ctx: sess.ctx,
			out: sess.out,
			fetchAudio: async (chunk, signal) => {
				const res = await post("/api/voice/speak", JSON.stringify({ text: chunk, voice: prefs.voice }), "application/json", signal);
				return res.arrayBuffer();
			},
			onStart: () => {
				if (sess.turn === turn) setState(sess, "speaking");
			},
			onIdle: () => {
				if (sess.turn !== turn) return;
				sess.turn = null;
				sess.speaker = null;
				idle(sess);
			},
			onError: (err) => {
				if (sess.turn !== turn || deps.isAuthError(err)) return;
				if (!turn.warned) toast("Couldn't play part of the reply");
				turn.warned = true;
			},
		});
		turn.speaker = speaker;
		sess.speaker = speaker;
		setState(sess, "thinking");

		const feed = (chunks) => chunks.forEach((chunk) => speaker.say(chunk));
		const previous = sess.request;
		const request = (async () => {
			await previous?.catch(() => {});
			if (sess.turn !== turn) return null;
			return deps.turn(text, { lang: voiceOf(prefs.voice).lang }, {
				onContent: (delta, msg) => {
					if (sess.turn !== turn) return;
					ui.reply.textContent = msg.content;
					feed(turn.chunker.push(delta));
				},
				// Runs before the message is rendered and saved: keep only what was said aloud.
				onEnd: (msg) => {
					turn.msg = msg;
					if (turn.interrupted) msg.content = msg.content.slice(0, turn.keep);
				},
			});
		})();
		sess.request = request;
		request
			.then((msg) => {
				if (sess.closed || sess.turn !== turn) return;
				if (!msg) {
					turn.speaker.stop();
					sess.turn = null;
					sess.speaker = null;
					idle(sess);
					return;
				}
				if (msg.error) {
					ui.reply.textContent = msg.error;
					toast(msg.error);
				}
				feed(turn.chunker.flush());
				speaker.finish();
			})
			.catch((err) => problem(sess, err, "The reply failed"));
	}

	// Stops speech and generation, and tells the chat where the reply was cut off.
	function interrupt(sess) {
		clearTimeout(sess.forceTimer);
		const turn = sess.turn;
		if (turn) {
			turn.interrupted = true;
			const spoken = turn.speaker.spoken();
			turn.keep = spoken > 0 ? (turn.chunker.ends[spoken - 1] ?? 0) : 0;
			sess.turn = null;
			// Text that is already complete is cut here; a reply still streaming is cut by onEnd once it stops.
			if (turn.msg && turn.keep < turn.msg.content.length) deps.cutReply(turn.msg, turn.keep);
		}
		sess.speaker?.stop();
		sess.speaker = null;
		if (turn) deps.stopReply();
	}

	/* ---------- Voice picker ---------- */

	function openSheet() {
		const sess = s;
		if (!sess || !config) return;
		interrupt(sess);
		sess.paused = true;
		sess.rec = null;
		sess.seg.reset();
		sess.state = sess.state === "starting" ? "starting" : prefs.mode === "ptt" ? "idle" : "listening";
		filter = voiceOf(prefs.voice)?.lang || "en";
		renderVoices();
		syncMic(sess);
		render();
		ui.sheet.inert = false;
		ui.sheet.classList.add("open");
		ui.scrim.hidden = false;
		requestAnimationFrame(() => ui.scrim.classList.add("show"));
		ui.sheetClose.focus({ preventScroll: true });
		ui.list.querySelector(".selected")?.scrollIntoView({ block: "center" });
	}

	function closeSheet() {
		if (!ui.sheet.classList.contains("open")) return;
		stopPreview(s);
		ui.sheet.classList.remove("open");
		ui.sheet.inert = true;
		ui.scrim.classList.remove("show");
		setTimeout(() => (ui.scrim.hidden = true), 260);
		if (s) {
			s.paused = false;
			s.seg.reset();
			syncMic(s);
			render();
			ui.chip.focus({ preventScroll: true });
		}
	}

	function renderVoices() {
		const counts = {};
		for (const v of config.voices) counts[v.lang] = (counts[v.lang] || 0) + 1;
		ui.filter.replaceChildren(
			...Object.keys(counts).map((lang) => {
				const b = el("button", "seg", `${LANGUAGES[lang] || lang} · ${counts[lang]}`);
				b.type = "button";
				b.setAttribute("role", "radio");
				b.setAttribute("aria-checked", String(lang === filter));
				b.dataset.lang = lang;
				return b;
			}),
		);
		ui.list.replaceChildren(
			...config.voices
				.filter((v) => v.lang === filter)
				.map((v) => {
					const row = el("div", `voice-row${v.id === prefs.voice ? " selected" : ""}`);
					row.dataset.id = v.id;
					const pick = el("button", "pick");
					pick.type = "button";
					pick.append(
						el("div", "name", cap(v.id)),
						el("div", "sub", `${cap(v.gender)} · ${v.accent} · ${v.age}`),
						el("div", "traits", v.traits.join(", ")),
					);
					const play = el("button", "icon-btn preview");
					play.type = "button";
					play.setAttribute("aria-label", `Preview ${cap(v.id)}`);
					play.append(icon("i-play"));
					const tick = icon("i-check");
					tick.classList.add("tick");
					row.append(pick, play, tick);
					return row;
				}),
		);
	}

	function pickVoice(id) {
		prefs.voice = id;
		storage.set(KEY_VOICE, id);
		ui.chipName.textContent = cap(id);
		renderVoices();
	}

	async function preview(id) {
		const sess = s;
		if (!sess) return;
		stopPreview(sess);
		const token = {};
		sess.preview = { token, source: null };
		try {
			const voice = voiceOf(id);
			const res = await post("/api/voice/speak", JSON.stringify({ text: PREVIEW[voice.lang](cap(id)), voice: id }), "application/json");
			const buffer = await sess.ctx.decodeAudioData(await res.arrayBuffer());
			if (s !== sess || sess.preview?.token !== token) return;
			if (sess.ctx.state !== "running") sess.ctx.resume().catch(() => {});
			const source = sess.ctx.createBufferSource();
			source.buffer = buffer;
			source.connect(sess.out);
			source.start();
			sess.preview.source = source;
		} catch (err) {
			problem(sess, err, "Couldn't play the preview");
		}
	}

	function stopPreview(sess) {
		if (!sess?.preview) return;
		try {
			sess.preview.source?.stop();
		} catch {}
		sess.preview = null;
	}

	function setMode(mode) {
		if (mode === prefs.mode) return;
		prefs.mode = mode;
		storage.set(KEY_MODE, mode);
		const sess = s;
		if (!sess) return;
		interrupt(sess);
		// The mute button only exists in hands-free mode, so tap to talk always starts with the microphone on.
		if (mode === "ptt" && sess.muted) {
			sess.muted = false;
			sess.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
		}
		if (sess.state !== "starting") idle(sess);
		syncMic(sess);
		render();
	}

	if (IOS) {
		ui.talkOver.querySelector("small").textContent =
			"Speak to interrupt. On iPhone this keeps the microphone open during replies, which can stop them playing aloud; with it off, tap the orb to interrupt.";
	}

	/* ---------- Events ---------- */

	ui.close.addEventListener("click", close);
	ui.orb.addEventListener("click", orbTap);
	ui.chip.addEventListener("click", openSheet);
	ui.sheetClose.addEventListener("click", closeSheet);
	ui.scrim.addEventListener("click", closeSheet);
	ui.mute.addEventListener("click", () => {
		const sess = s;
		if (!sess) return;
		sess.muted = !sess.muted;
		sess.stream?.getAudioTracks().forEach((t) => (t.enabled = !sess.muted));
		if (sess.muted) {
			sess.micLevel = 0;
			if (sess.state === "recording") idle(sess);
			sess.seg.reset();
		}
		syncMic(sess);
		render();
	});
	ui.modes.addEventListener("click", (e) => {
		const b = e.target.closest(".seg");
		if (b) setMode(b.dataset.mode);
	});
	ui.talkOver.addEventListener("click", () => {
		prefs.talkOver = !prefs.talkOver;
		storage.set(KEY_TALK_OVER, prefs.talkOver ? "1" : "0");
		if (s) syncMic(s);
		render();
	});
	ui.filter.addEventListener("click", (e) => {
		const b = e.target.closest(".seg");
		if (!b) return;
		filter = b.dataset.lang;
		renderVoices();
	});
	ui.list.addEventListener("click", (e) => {
		const row = e.target.closest(".voice-row");
		if (!row) return;
		if (e.target.closest(".preview")) preview(row.dataset.id);
		else pickVoice(row.dataset.id);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || !s) return;
		if (ui.sheet.classList.contains("open")) closeSheet();
		else close();
	});
	// The microphone and audio output stop in the background on phones, so end the session instead of leaving a dead one.
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) close();
	});
	addEventListener("pagehide", close);

	return {
		open,
		close,
		get isOpen() {
			return Boolean(s);
		},
	};
}

/**
 * Plays synthesized sentences in order with no gaps. Each sentence is fetched as soon as it is queued
 * (at most two at a time), then scheduled right after the previous one on the audio clock.
 */
class Speaker {
	constructor({ ctx, out, fetchAudio, onStart, onIdle, onError }) {
		Object.assign(this, { ctx, out, fetchAudio, onStart, onIdle, onError });
		this.items = [];
		this.next = 0;
		this.endTime = 0;
		this.sources = new Set();
		this.timers = new Set();
		this.abort = new AbortController();
		this.waiting = [];
		this.running = 0;
		this.started = 0;
		this.pumping = false;
		this.finished = false;
		this.stopped = false;
		this.idled = false;
	}

	spoken() {
		return this.started;
	}

	say(text) {
		if (this.stopped || this.finished) return;
		const item = { text, promise: null, source: null };
		item.promise = this.slot(() => this.fetchAudio(text, this.abort.signal)).then((data) => this.ctx.decodeAudioData(data));
		item.promise.catch(() => {});
		this.items.push(item);
		this.pump();
	}

	finish() {
		this.finished = true;
		this.check();
	}

	stop() {
		this.stopped = true;
		this.abort.abort();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const source of this.sources) {
			source.onended = null;
			try {
				source.stop();
			} catch {}
		}
		this.sources.clear();
		for (const run of this.waiting.splice(0)) run();
	}

	slot(task) {
		return new Promise((resolve, reject) => {
			const run = () => {
				if (this.stopped) {
					reject(new DOMException("Stopped", "AbortError"));
					return;
				}
				this.running++;
				task()
					.then(resolve, reject)
					.finally(() => {
						this.running--;
						this.waiting.shift()?.();
					});
			};
			if (this.running < 2) run();
			else this.waiting.push(run);
		});
	}

	async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.next < this.items.length && !this.stopped) {
				const item = this.items[this.next];
				let buffer = null;
				try {
					buffer = await item.promise;
				} catch (err) {
					if (this.stopped) return;
					this.onError(err);
				}
				if (this.stopped) return;
				this.next++;
				if (buffer) this.schedule(item, buffer);
			}
		} finally {
			this.pumping = false;
		}
		if (!this.stopped && this.next < this.items.length) this.pump();
		else this.check();
	}

	schedule(item, buffer) {
		if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
		const source = this.ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.out);
		const when = Math.max(this.ctx.currentTime + 0.03, this.endTime);
		source.start(when);
		this.endTime = when + buffer.duration;
		this.sources.add(source);
		source.onended = () => {
			this.sources.delete(source);
			this.check();
		};
		const index = this.items.indexOf(item) + 1;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (this.stopped) return;
			this.started = index;
			this.onStart();
		}, Math.max(0, (when - this.ctx.currentTime) * 1000));
		this.timers.add(timer);
	}

	check() {
		if (this.stopped || this.idled || !this.finished || this.pumping) return;
		if (this.next < this.items.length || this.sources.size > 0 || this.timers.size > 0) return;
		this.idled = true;
		this.onIdle();
	}
}
