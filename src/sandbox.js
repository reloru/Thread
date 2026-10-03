import { DurableObject } from "cloudflare:workers";

const PORT = 8080;
const IDLE_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 90 * 1000;

// One instance per chat (named by chat id). Runs model-written Python in an isolated
// container with no outbound network.
export class Sandbox extends DurableObject {
	async run(code) {
		await this.ready();
		const res = await this.ctx.container.getTcpPort(PORT).fetch("http://container/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
			signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
		});
		if (!res.ok) return { stdout: "", stderr: "", error: `Sandbox returned HTTP ${res.status}.`, images: [] };
		return res.json();
	}

	ready() {
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async start() {
		const container = this.ctx.container;
		if (!container.running) {
			this.exitError = undefined;
			container.start({ image: container.images.base, instance: "standard-1", enableInternet: false });
			this.ctx.waitUntil(
				container.monitor().then(
					() => (this.exitError = "the sandbox process exited"),
					(err) => {
						this.exitError = err?.message || String(err);
						console.error("sandbox container error", this.exitError);
					},
				),
			);
		}
		await container.setInactivityTimeout(IDLE_MS);
		const port = container.getTcpPort(PORT);
		let lastError;
		for (let attempt = 0; attempt < 150; attempt++) {
			try {
				const res = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1000) });
				await res.body?.cancel();
				if (res.ok) return;
			} catch (err) {
				lastError = err;
			}
			if (this.exitError) throw new Error(`The sandbox failed to start: ${this.exitError}`);
			await scheduler.wait(300);
		}
		console.error("sandbox readiness timeout", lastError?.message);
		throw new Error(`The sandbox did not start in time (${lastError?.message || "no response"}).`);
	}
}
