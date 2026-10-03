// Prices are USD per million tokens [input, output], from the Workers AI model catalog API.
// Parameter specs come from each model's input schema (GET /ai/models/schema), narrowed where
// live requests disagreed with the schema; those cases carry a `note`.

const DEFAULT_MAX_TOKENS = 16384;

const temperature = (extra = {}) => ({
	key: "temperature",
	label: "Temperature",
	group: "Sampling",
	type: "number",
	min: 0,
	max: 2,
	step: 0.05,
	default: 1,
	help: "Sampling temperature between 0 and 2.",
	...extra,
});
const topP = (extra = {}) => ({
	key: "top_p",
	label: "Top P",
	group: "Sampling",
	type: "number",
	min: 0,
	max: 1,
	step: 0.01,
	default: 1,
	help: "Nucleus sampling: considers the results of the tokens with top_p probability mass.",
	...extra,
});
const frequencyPenalty = {
	key: "frequency_penalty",
	label: "Frequency penalty",
	group: "Sampling",
	type: "number",
	min: -2,
	max: 2,
	step: 0.05,
	default: 0,
	help: "Penalizes new tokens based on their existing frequency in the text so far.",
};
const presencePenalty = {
	key: "presence_penalty",
	label: "Presence penalty",
	group: "Sampling",
	type: "number",
	min: -2,
	max: 2,
	step: 0.05,
	default: 0,
	help: "Penalizes new tokens based on whether they appear in the text so far.",
};
const maxTokens = (context, def = DEFAULT_MAX_TOKENS, extra = {}) => ({
	key: "max_completion_tokens",
	label: "Max output tokens",
	group: "Output",
	type: "integer",
	min: 1,
	max: context,
	default: def,
	help: `An upper bound for the number of tokens that can be generated, reasoning included. When unset, the app sends ${def}.`,
	...extra,
});
const seed = (extra = {}) => ({
	key: "seed",
	label: "Seed",
	group: "Output",
	type: "integer",
	help: "If specified, the system will make a best effort to sample deterministically.",
	...extra,
});
const stop = {
	key: "stop",
	label: "Stop sequences",
	group: "Output",
	type: "stop",
	maxItems: 4,
	help: "Up to 4 sequences where generation stops. One per line.",
};
const responseFormat = (options) => ({
	key: "response_format",
	label: "Response format",
	group: "Output",
	type: "format",
	options,
	help: "Specifies the format the model must output. Use Advanced JSON for json_schema.",
});
const logitBias = {
	key: "logit_bias",
	label: "Logit bias",
	group: "Output",
	type: "bias",
	help: "Maps token IDs to bias values from -100 to 100, as JSON.",
};
const reasoningEffort = (options, def, extra = {}) => ({
	key: "reasoning_effort",
	label: "Reasoning effort",
	group: "Reasoning",
	type: "enum",
	options,
	default: def,
	...extra,
});
const enableThinking = (extra = {}) => ({
	key: "enable_thinking",
	path: "chat_template_kwargs",
	label: "Thinking",
	group: "Reasoning",
	type: "boolean",
	default: true,
	help: "Whether to enable reasoning for this model.",
	...extra,
});
const clearThinking = {
	key: "clear_thinking",
	path: "chat_template_kwargs",
	label: "Clear thinking",
	group: "Reasoning",
	type: "boolean",
	default: false,
	help: "If false, preserves reasoning context between turns.",
};
const lowEffort = {
	key: "low_effort",
	path: "chat_template_kwargs",
	label: "Low effort",
	group: "Reasoning",
	type: "boolean",
	default: false,
	help: "When Thinking is on, use Nemotron's low-effort reasoning mode, which uses significantly fewer reasoning tokens.",
};
const forceNonemptyContent = {
	key: "force_nonempty_content",
	path: "chat_template_kwargs",
	label: "Force non-empty content",
	group: "Output",
	type: "boolean",
	default: false,
	help: "Cloudflare's docs: NVIDIA suggests turning this on for coding agents.",
};

// Schema fields of the OpenAI-compatible chat models that have no dedicated control.
// They are accepted from the Advanced JSON box and passed through unchanged.
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

const TOP_P_FLOOR = { min: 0.001, note: "The schema allows 0; the service rejects it." };

const chatControls = (context, reasoning, { topPExtra } = {}) => [
	...reasoning,
	temperature(),
	topP(topPExtra),
	frequencyPenalty,
	presencePenalty,
	maxTokens(context),
	stop,
	seed(),
	responseFormat(["text", "json_object"]),
	logitBias,
];

export const MODELS = [
	{
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM-5.3 Flash",
		vendor: "Z.ai",
		vision: true,
		context: 1048576,
		price: [0.15, 0.5],
		controls: chatControls(1048576, [
			reasoningEffort(["max", "high", "low"], "max", { help: "Reasoning cannot be disabled for this model." }),
			clearThinking,
		]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/google/gemma-4-26b-a4b-it",
		name: "Gemma 4 26B",
		vendor: "Google",
		vision: true,
		context: 256000,
		price: [0.1, 0.3],
		controls: [
			...chatControls(256000, [enableThinking(), clearThinking]),
			{ key: "skip_special_tokens", label: "Skip special tokens", group: "Output", type: "boolean", default: false },
		],
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		name: "Llama 3.3 70B",
		vendor: "Meta",
		vision: false,
		context: 24000,
		price: [0.293, 2.253],
		defaultMaxTokens: 4096,
		controls: [
			temperature({
				default: 0.6,
				help: "Controls the randomness of the output; higher values produce more random results.",
				note: "The schema allows up to 5; the service rejects values above 2.",
			}),
			topP({
				min: 0.001,
				default: undefined,
				help: "Lower values make outputs more predictable; higher values allow for more varied responses.",
			}),
			{
				key: "top_k",
				label: "Top K",
				group: "Sampling",
				type: "integer",
				min: 1,
				max: 50,
				help: "Limits the model to choose from the top k most probable tokens.",
			},
			frequencyPenalty,
			presencePenalty,
			{
				key: "repetition_penalty",
				label: "Repetition penalty",
				group: "Sampling",
				type: "number",
				min: 0,
				max: 2,
				step: 0.05,
				help: "Penalty for repeated tokens; higher values discourage repetition.",
			},
			maxTokens(24000, 4096, {
				note: "The prompt and the output together must fit in the 24,000-token context window; the service rejects a request otherwise.",
			}),
			stop,
			seed({ min: 1, max: 9999999999, help: "Random seed for reproducibility of the generation." }),
			responseFormat(["json_object"]),
		],
		extraKeys: ["functions", "max_tokens", "raw", "tools"],
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "gpt-oss-120b",
		vendor: "OpenAI",
		vision: false,
		context: 128000,
		price: [0.35, 0.75],
		controls: [
			reasoningEffort(["low", "medium", "high"], "medium", { help: "Reasoning cannot be disabled for this model." }),
			temperature({
				default: 0.6,
				help: "Controls the randomness of the output; higher values produce more random results.",
				note: "The schema allows up to 5; the service rejects values above 2.",
			}),
			topP({
				min: 0.001,
				default: undefined,
				help: "Lower values make outputs more predictable; higher values allow for more varied responses.",
			}),
			{
				key: "top_k",
				label: "Top K",
				group: "Sampling",
				type: "integer",
				min: 1,
				max: 50,
				help: "Limits the model to choose from the top k most probable tokens.",
			},
			frequencyPenalty,
			presencePenalty,
			{
				key: "repetition_penalty",
				label: "Repetition penalty",
				group: "Sampling",
				type: "number",
				min: 0,
				max: 2,
				step: 0.05,
				help: "Penalty for repeated tokens; higher values discourage repetition.",
			},
			maxTokens(128000),
			stop,
			seed({ min: 1, max: 9999999999, help: "Random seed for reproducibility of the generation." }),
			responseFormat(["json_object"]),
			logitBias,
		],
		extraKeys: ["functions", "max_tokens", "raw", "tools"],
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		vendor: "DeepSeek",
		vision: false,
		context: 1048576,
		price: [0.44, 1.32],
		controls: chatControls(1048576, [
			reasoningEffort(["max", "high", "low", "none"], "high", {
				note: "In testing, “none” still produced reasoning. Turn Thinking off to disable it.",
			}),
			enableThinking(),
			clearThinking,
		]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/qwen/qwen3.8-27b",
		name: "Qwen 3.8 27B",
		vendor: "Alibaba",
		vision: true,
		context: 262144,
		price: [0.45, 3.2],
		controls: chatControls(
			262144,
			[
				reasoningEffort(["xhigh", "medium", "low"], "xhigh", { help: "Turn Thinking off to disable reasoning." }),
				enableThinking(),
				clearThinking,
			],
			{ topPExtra: TOP_P_FLOOR },
		),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/nvidia/nemotron-3-120b-a12b",
		name: "Nemotron 3 120B",
		vendor: "NVIDIA",
		vision: false,
		context: 256000,
		price: [0.5, 1.5],
		controls: [
			...chatControls(
				256000,
				[
					enableThinking({ help: "Reasoning is on by default. This model has no reasoning effort field; use Low effort instead." }),
					lowEffort,
				],
				{ topPExtra: TOP_P_FLOOR },
			),
			forceNonemptyContent,
		],
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		vendor: "Moonshot AI",
		vision: true,
		context: 262144,
		price: [0.95, 4],
		controls: chatControls(262144, [
			reasoningEffort(["high", "none"], "high", { help: "“none” disables reasoning." }),
			enableThinking({ note: "In testing, turning this off did not stop reasoning. Use effort “none”." }),
			clearThinking,
		]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro",
		vendor: "DeepSeek",
		vision: false,
		context: 1048576,
		price: [1.32, 3.96],
		controls: chatControls(
			1048576,
			[
				reasoningEffort(["max", "high", "low", "none"], "high", {
					note: "In testing, “none” still produced reasoning. Turn Thinking off to disable it.",
				}),
				enableThinking(),
				clearThinking,
			],
			{ topPExtra: TOP_P_FLOOR },
		),
		extraKeys: CHAT_EXTRA_KEYS,
	},
	{
		id: "@cf/zai-org/glm-5.3",
		name: "GLM-5.3",
		vendor: "Z.ai",
		vision: false,
		context: 1048576,
		price: [1.4, 4.4],
		controls: chatControls(1048576, [
			reasoningEffort(["max", "high", "low"], "max", { help: "Reasoning cannot be disabled for this model." }),
			clearThinking,
		]),
		extraKeys: CHAT_EXTRA_KEYS,
	},
];

export const DEFAULT_MODEL = MODELS[0].id;
export { DEFAULT_MAX_TOKENS };
