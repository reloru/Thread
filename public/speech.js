// Turns streamed markdown into short spoken chunks. Aura-2 takes at most 2000 characters per request and
// synthesis time grows with length, so replies are spoken sentence by sentence.

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;
const SENTENCE_END = /[.!?…。！？]+["'”’)\]]*\s+|\n+/;
const CLAUSE_END = /[,;:—–]\s/g;
const PUNCTUATED = /[.!?…:;,。！？]["'”’)\]]*$/;

/** Markdown to plain text for reading aloud. */
export function toSpeech(markdown) {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>\n]+>/g, " ")
		.replace(/https?:\/\/(?:www\.)?([^\s/)]+)[^\s)]*/g, "$1")
		.replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*(?:\n|$)/gm, "")
		.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split("|").map((c) => c.trim()).filter(Boolean).join(", "))
		.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
		.replace(/^[ \t]*>+[ \t]?/gm, "")
		.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
		.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(EMOJI, "")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();
}

/**
 * Feed streamed text with push(); it returns the chunks that are ready to speak. flush() returns the rest.
 * Fenced code blocks are skipped. Fragments shorter than minChars are joined to the next one, except that
 * the first chunk may be short so speech starts early.
 */
export function createChunker({ minChars = 30, firstMinChars = 12, maxChars = 220, firstClauseAfter = 30, firstSentenceMax = 80 } = {}) {
	let buffer = "";
	let pending = "";
	let fenced = false;
	let consumed = 0;
	// ends[i] is how many characters of the pushed text had been consumed when chunk i was emitted.
	const ends = [];

	const need = () => (ends.length === 0 ? firstMinChars : minChars);
	const drop = (count) => {
		buffer = buffer.slice(count);
		consumed += count;
	};

	function take(final) {
		const out = [];
		const emit = (text) => {
			out.push(text);
			ends.push(consumed);
		};
		const addPending = (spoken) => {
			if (!spoken) return;
			// Lines without end punctuation (list items, headings) get a full stop so the voice pauses.
			pending = pending ? `${pending}${PUNCTUATED.test(pending) ? " " : ". "}${spoken}` : spoken;
			while (pending.length > maxChars) {
				const cut = splitPoint(pending, maxChars);
				emit(pending.slice(0, cut).trim());
				pending = pending.slice(cut).trim();
			}
			if (pending.length >= need()) {
				emit(pending);
				pending = "";
			}
		};
		const takeUnit = (count) => {
			const unit = buffer.slice(0, count);
			drop(count);
			addPending(toSpeech(unit));
		};

		for (;;) {
			const newline = buffer.indexOf("\n");
			const line = newline === -1 ? buffer : buffer.slice(0, newline);
			if (/^\s*```/.test(line) && (newline !== -1 || final)) {
				fenced = !fenced;
				drop(newline === -1 ? buffer.length : newline + 1);
				continue;
			}
			if (fenced) {
				if (newline === -1) {
					if (final) drop(buffer.length);
					break;
				}
				drop(newline + 1);
				continue;
			}
			if (/^\s*`{1,2}$/.test(line) && !final) break;

			const match = SENTENCE_END.exec(buffer);
			if (ends.length === 0 && !pending) {
				// A long first sentence is spoken from its first clause, so the voice starts sooner.
				const reach = match ? match.index + match[0].length : buffer.length;
				const clause = reach > firstSentenceMax ? firstClause(buffer.slice(0, reach), firstClauseAfter) : -1;
				if (clause > 0) {
					takeUnit(clause);
					continue;
				}
			}
			if (match) {
				const end = match.index + match[0].length;
				// A boundary at the very end of the buffer may continue ("3." then "5"), unless the text is final.
				if (end === buffer.length && !final && !/\n$/.test(match[0])) break;
				takeUnit(end);
				continue;
			}
			if (buffer.length > maxChars * 1.5) {
				takeUnit(splitPoint(buffer, maxChars));
				continue;
			}
			break;
		}

		if (final) {
			takeUnit(buffer.length);
			if (pending) {
				emit(pending);
				pending = "";
			}
		}
		return out;
	}

	return {
		ends,
		push(text) {
			buffer += text;
			return take(false);
		},
		flush() {
			return take(true);
		},
	};
}

function firstClause(text, after) {
	for (const m of text.matchAll(CLAUSE_END)) {
		const end = m.index + m[0].length;
		if (end >= after && end < text.length) return end;
	}
	return -1;
}

function splitPoint(text, max) {
	const head = text.slice(0, max);
	let cut = -1;
	for (const m of head.matchAll(CLAUSE_END)) cut = m.index + m[0].length;
	if (cut < max * 0.4) cut = head.lastIndexOf(" ") + 1;
	return cut > 0 ? cut : max;
}
