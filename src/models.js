// Prices are USD per million tokens [input, output], from the Workers AI model catalog API.
export const MODELS = [
	{
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM-5.3 Flash",
		vendor: "Z.ai",
		vision: true,
		context: 1048576,
		price: [0.15, 0.5],
	},
	{
		id: "@cf/google/gemma-4-26b-a4b-it",
		name: "Gemma 4 26B",
		vendor: "Google",
		vision: true,
		context: 256000,
		price: [0.1, 0.3],
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "gpt-oss-120b",
		vendor: "OpenAI",
		vision: false,
		context: 128000,
		price: [0.35, 0.75],
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		vendor: "DeepSeek",
		vision: false,
		context: 1048576,
		price: [0.44, 1.32],
	},
	{
		id: "@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		vendor: "Moonshot AI",
		vision: true,
		context: 262144,
		price: [0.95, 4],
	},
	{
		id: "@cf/zai-org/glm-5.3",
		name: "GLM-5.3",
		vendor: "Z.ai",
		vision: false,
		context: 1048576,
		price: [1.4, 4.4],
	},
];

export const DEFAULT_MODEL = MODELS[0].id;
