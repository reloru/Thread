// Prices are USD per million tokens [input, output], from the Workers AI model catalog API.
// Parameter specs come from each model's input schema (GET /ai/models/schema), narrowed where
// live requests disagreed with the schema. `default` is the schema's documented default, shown greyed
// out in an empty field; it is not sent. Max output tokens is the exception: the Worker always sends it.

const DEFAULT_MAX_TOKENS = 16384;

const temperature = (extra = {}) => ({
	key: "temperature",
	label: "Temperature",
	group: "Randomness",
	type: "number",
	min: 0,
	max: 2,
	step: 0.05,
	default: 1,
	help: "How predictable replies are. Lower values give focused, consistent answers; higher values give more varied, creative ones.",
	...extra,
});
const topP = (extra = {}) => ({
	key: "top_p",
	label: "Top P",
	group: "Randomness",
	type: "number",
	min: 0,
	max: 1,
	step: 0.01,
	default: 1,
	help: "Limits the model to its most likely next tokens. At 1 it can use any of them; at 0.1, only the few that make up the top 10% of the odds. Lower values make replies more predictable. It's usually best to change this or Temperature, not both.",
	...extra,
});
const FREQUENCY_HELP =
	"Makes the model less likely to repeat words it has already used, more strongly the more often it has used them. Raise it if replies keep repeating themselves.";
const PRESENCE_HELP = "Makes the model less likely to use a word again once it has appeared at all, which nudges it toward new topics.";
const frequencyPenalty = {
	key: "frequency_penalty",
	label: "Frequency penalty",
	group: "Word choice",
	type: "number",
	min: -2,
	max: 2,
	step: 0.05,
	default: 0,
	help: `${FREQUENCY_HELP} Negative values make repetition more likely.`,
};
const presencePenalty = {
	key: "presence_penalty",
	label: "Presence penalty",
	group: "Word choice",
	type: "number",
	min: -2,
	max: 2,
	step: 0.05,
	default: 0,
	help: `${PRESENCE_HELP} Negative values make it stick to what it has already said.`,
};
const MAX_TOKENS_HELP =
	"The longest a reply can be, in tokens. A token is a short piece of text, often part of a word. A reply that reaches the limit stops partway and is marked “Hit length limit”.";
// For models that think: verified on Qwen 3.8 and gpt-oss-120b, where a small limit ran out during thinking.
const MAX_TOKENS_THINKING_HELP =
	"The longest a reply can be, in tokens. A token is a short piece of text, often part of a word. Thinking counts toward the limit too, so a model that thinks for a long time can use it up before it starts answering. A reply that reaches the limit stops partway and is marked “Hit length limit”.";
const maxTokens = (context, def = DEFAULT_MAX_TOKENS, extra = {}) => ({
	key: "max_completion_tokens",
	label: "Max output tokens",
	group: "Reply length",
	type: "integer",
	min: 1,
	max: context,
	default: def,
	help: MAX_TOKENS_THINKING_HELP,
	...extra,
});
const seed = (extra = {}) => ({
	key: "seed",
	label: "Seed",
	group: "Randomness",
	type: "integer",
	placeholder: "Random",
	help: "Replies are normally different every time, even for the same message. Enter a whole number to make them repeatable: the same chat with the same settings and number should give the same reply again, though an exact match isn't guaranteed.",
	...extra,
});
const stop = {
	key: "stop",
	label: "Stop sequences",
	group: "Reply length",
	type: "stop",
	maxItems: 4,
	placeholder: "e.g. In conclusion",
	help: "The reply ends as soon as the model writes one of these words or phrases, and the phrase itself is left out. Put each one on its own line, up to 4.",
};
// Not shown in the app; kept so the Worker's validation is unchanged.
const responseFormat = (options) => ({
	key: "response_format",
	label: "Response format",
	hidden: true,
	type: "format",
	options,
});
const biasHelp = (max) =>
	`Makes specific tokens more or less likely. Enter JSON that pairs a token ID with a number from -100 to ${max}. Small numbers nudge the odds; -100 should ban that token outright. Each model numbers its tokens differently.`;
const logitBias = {
	key: "logit_bias",
	label: "Logit bias",
	group: "Word choice",
	type: "bias",
	placeholder: 'e.g. {"1234": -100}',
	help: biasHelp(100),
};
const REASONING_HELP = "How much the model thinks before it answers. Higher levels think longer, which takes more time and more tokens.";
const ALWAYS_THINKS = "This model always thinks; it can't be turned off.";
const THINKING_TOGGLE = "To skip thinking, turn Thinking off.";
const reasoningEffort = (options, def, tail, extra = {}) => ({
	key: "reasoning_effort",
	label: "Reasoning effort",
	group: "Thinking",
	type: "enum",
	options,
	default: def,
	help: `${REASONING_HELP} ${tail}`,
	...extra,
});
const THINKING_HELP = "Lets the model think a problem through before answering. You can open its thinking above the reply. Turn it off for faster replies.";
const enableThinking = (extra = {}) => ({
	key: "enable_thinking",
	path: "chat_template_kwargs",
	label: "Thinking",
	group: "Thinking",
	type: "boolean",
	default: true,
	help: THINKING_HELP,
	...extra,
});
// Request overrides applied in voice mode (model.voiceParams), so the first words are spoken sooner.
// Only models with a verified way to switch reasoning off have one.
const THINKING_OFF = { chat_template_kwargs: { enable_thinking: false } };

const lowEffort = {
	key: "low_effort",
	path: "chat_template_kwargs",
	label: "Low-effort thinking",
	group: "Thinking",
	type: "boolean",
	default: false,
	help: "When Thinking is on, the model thinks more briefly and uses far fewer tokens.",
};

// Schema fields of the OpenAI-compatible chat models that have no control in the app.
// The Worker accepts them in params and passes them through unchanged.
const CHAT_EXTRA_KEYS = [
	"audio",
	"function_call",
	"functions",
	"logprobs",
	"max_tokens",
	"metadata",
	"modalities",
	"n",
	"parallel_tool_calls",
	"prediction",
	"store",
	"stream_options",
	"tool_choice",
	"tools",
	"top_logprobs",
	"user",
	"web_search_options",
];

// Every chat model rejects top_p 0 (HTTP 400, 500 on Nemotron), whatever its schema says.
const TOP_P_FLOOR = { min: 0.001 };

// options.seed = false leaves seed out for models where repeated runs with the same seed did not match.
const chatControls = (context, reasoning, options = {}) => [
	...reasoning,
	temperature(),
	topP(TOP_P_FLOOR),
	frequencyPenalty,
	presencePenalty,
	maxTokens(context),
	stop,
	...(options.seed === false ? [] : [seed()]),
	responseFormat(["json_object"]),
	logitBias,
];

const UNUSABLE_ABOVE_2 = "You can go up to 5, but replies turned to nonsense above about 2 in testing.";

// Controls for models on the older Workers AI schema (top_k and repetition_penalty instead of the
// OpenAI-style extras), which differ per model in the ranges below. Their schemas document no default
// for top_p, top_k or the penalties.
const olderControls = ({ reasoning = [], temp, penalties = [frequencyPenalty, presencePenalty], repetition = {}, max, formats = ["json_object"], bias = [] }) => [
	...reasoning,
	temperature({ default: 0.6, ...temp }),
	topP({ min: 0.001, default: undefined }),
	{
		key: "top_k",
		label: "Top K",
		group: "Randomness",
		type: "integer",
		min: 1,
		max: 50,
		help: "Limits the model to this many of its most likely next tokens at each step. Lower values make replies more focused; higher values allow more variety.",
	},
	...penalties.map((p) => ({ ...p, default: undefined })),
	{
		key: "repetition_penalty",
		label: "Repetition penalty",
		group: "Word choice",
		type: "number",
		// The service rejects 0.
		min: 0.05,
		max: 2,
		step: 0.05,
		help: "Makes the model less likely to repeat words. Higher values push harder against repetition; lower values allow more.",
		...repetition,
	},
	max,
	stop,
	seed({ min: 1, max: 9999999999 }),
	...(formats.length ? [responseFormat(formats)] : []),
	...bias,
];

const OLDER_EXTRA_KEYS = ["functions", "max_tokens", "raw", "tools"];

export const MODELS = [
	{
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM-5.3 Flash",
		vendor: "Z.ai",
		vision: true,
		context: 1048576,
		price: [0.15, 0.5],
		controls: chatControls(1048576, [reasoningEffort(["max", "high", "low"], "max", ALWAYS_THINKS)], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/google/gemma-4-26b-a4b-it",
		name: "Gemma 4 26B",
		vendor: "Google",
		vision: true,
		context: 256000,
		price: [0.1, 0.3],
		voiceParams: THINKING_OFF,
		controls: chatControls(256000, [enableThinking()], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/ibm-granite/granite-4.0-h-micro",
		name: "Granite 4.0 Micro",
		vendor: "IBM",
		vision: false,
		context: 131000,
		price: [0.017, 0.112],
		controls: olderControls({
			temp: { max: 5, note: UNUSABLE_ABOVE_2 },
			max: maxTokens(131000, DEFAULT_MAX_TOKENS, { help: MAX_TOKENS_HELP }),
		}),
		extraKeys: OLDER_EXTRA_KEYS,
	},
	{
		id: "@cf/openai/gpt-oss-20b",
		name: "gpt-oss-20b",
		vendor: "OpenAI",
		vision: false,
		context: 128000,
		price: [0.2, 0.3],
		controls: olderControls({
			reasoning: [reasoningEffort(["low", "medium", "high"], "medium", ALWAYS_THINKS)],
			// Outside these limits replies came back empty or as garbage with leaked format tokens.
			temp: { max: 1 },
			repetition: { min: 0.7 },
			max: maxTokens(128000),
			formats: [],
			bias: [{ ...logitBias, max: 30, help: biasHelp(30) }],
		}),
		extraKeys: OLDER_EXTRA_KEYS,
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		name: "Llama 3.3 70B",
		vendor: "Meta",
		vision: false,
		context: 24000,
		price: [0.293, 2.253],
		defaultMaxTokens: 4096,
		controls: olderControls({
			// The schema allows up to 5; the service rejects values above 2.
			temp: {},
			max: maxTokens(24000, 4096, {
				help: MAX_TOKENS_HELP,
				note: "This model can take 24,000 tokens in total, counting the whole chat and the reply. If the chat plus this limit adds up to more, the request fails.",
			}),
		}),
		extraKeys: OLDER_EXTRA_KEYS,
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "gpt-oss-120b",
		vendor: "OpenAI",
		vision: false,
		context: 128000,
		price: [0.35, 0.75],
		controls: olderControls({
			reasoning: [reasoningEffort(["low", "medium", "high"], "medium", ALWAYS_THINKS)],
			// Outside these limits replies came back empty, as garbage with leaked format tokens, or as a stream error.
			temp: { max: 1.2 },
			repetition: { min: 0.7 },
			max: maxTokens(128000),
			bias: [logitBias],
		}),
		extraKeys: OLDER_EXTRA_KEYS,
	},
	{
		id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
		name: "Mistral Small 3.1",
		vendor: "Mistral AI",
		vision: true,
		context: 128000,
		price: [0.351, 0.555],
		controls: olderControls({
			temp: { max: 5, default: 0.15, note: UNUSABLE_ABOVE_2 },
			// This model rejects negative penalties.
			penalties: [
				{ ...frequencyPenalty, min: 0, help: FREQUENCY_HELP },
				{ ...presencePenalty, min: 0, help: PRESENCE_HELP },
			],
			max: maxTokens(128000, DEFAULT_MAX_TOKENS, { help: MAX_TOKENS_HELP }),
		}),
		extraKeys: OLDER_EXTRA_KEYS,
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		vendor: "DeepSeek",
		vision: false,
		context: 1048576,
		price: [0.44, 1.32],
		voiceParams: THINKING_OFF,
		controls: chatControls(1048576, [reasoningEffort(["max", "high", "low"], "high", THINKING_TOGGLE), enableThinking()], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/qwen/qwen3.8-27b",
		name: "Qwen 3.8 27B",
		vendor: "Alibaba",
		vision: true,
		context: 262144,
		price: [0.45, 3.2],
		voiceParams: THINKING_OFF,
		controls: chatControls(262144, [reasoningEffort(["xhigh", "medium", "low"], "xhigh", THINKING_TOGGLE), enableThinking()]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/nvidia/nemotron-3-120b-a12b",
		name: "Nemotron 3 120B",
		vendor: "NVIDIA",
		vision: false,
		context: 256000,
		price: [0.5, 1.5],
		voiceParams: THINKING_OFF,
		// With Thinking off the service streams the reply in the reasoning field; the Worker moves it into content.
		replyInReasoningWhenThinkingOff: true,
		controls: chatControls(256000, [
			enableThinking({ help: `${THINKING_HELP} This model has no Reasoning effort setting; use Low-effort thinking to make it think less.` }),
			lowEffort,
		]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		vendor: "Moonshot AI",
		vision: true,
		context: 262144,
		price: [0.95, 4],
		voiceParams: { reasoning_effort: "none" },
		controls: chatControls(262144, [reasoningEffort(["high", "none"], "high", "Choose None to skip thinking.")], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/moonshotai/kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		vendor: "Moonshot AI",
		vision: true,
		context: 262144,
		price: [0.95, 4],
		controls: chatControls(262144, [], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro",
		vendor: "DeepSeek",
		vision: false,
		context: 1048576,
		price: [1.32, 3.96],
		voiceParams: THINKING_OFF,
		controls: chatControls(1048576, [reasoningEffort(["max", "high", "low"], "high", THINKING_TOGGLE), enableThinking()], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/zai-org/glm-5.3",
		name: "GLM-5.3",
		vendor: "Z.ai",
		vision: false,
		context: 1048576,
		price: [1.4, 4.4],
		controls: chatControls(1048576, [reasoningEffort(["max", "high", "low"], "max", ALWAYS_THINKS)], { seed: false }),
		extraKeys: CHAT_EXTRA_KEYS,
	},
];

export const DEFAULT_MODEL = MODELS[0].id;
export { DEFAULT_MAX_TOKENS };
