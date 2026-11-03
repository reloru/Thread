import { agentStream, reasoningAsContent } from "./agent.js";
import { aiOptions } from "./http.js";

/**
 * The model's SSE stream for one reply. job: { model, input, tools, chatId, asContent }, as built and validated
 * by the Worker. signal stops the tool loop between steps (the caller cancels the stream itself).
 */
export async function generate(env, { model, input, tools = [], chatId, asContent = false }, signal) {
	const options = aiOptions(env);
	if (tools.length) return agentStream({ env, model, input, tools, chatId, options, asContent, signal });
	const stream = await env.AI.run(model, input, options);
	return asContent ? reasoningAsContent(stream) : stream;
}
