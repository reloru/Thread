import { agentStream } from "./agent.js";
import { aiOptions } from "./http.js";

/**
 * The model's SSE stream for one reply. job: { model, input, tools, chatId }, as built and validated by the Worker.
 * signal stops the tool loop between steps (the caller cancels the stream itself).
 */
export async function generate(env, { model, input, tools = [], chatId }, signal) {
	const options = aiOptions(env);
	if (tools.length) return agentStream({ env, model, input, tools, chatId, options, signal });
	return env.AI.run(model, input, options);
}
