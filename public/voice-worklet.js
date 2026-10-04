// Forwards microphone audio to the main thread in blocks of 512 samples at the context's sample rate.
class Tap extends AudioWorkletProcessor {
	constructor() {
		super();
		this.block = new Float32Array(512);
		this.at = 0;
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel) return true;
		for (let i = 0; i < channel.length; i++) {
			this.block[this.at++] = channel[i];
			if (this.at === this.block.length) {
				this.port.postMessage(this.block, [this.block.buffer]);
				this.block = new Float32Array(512);
				this.at = 0;
			}
		}
		return true;
	}
}

registerProcessor("thread-tap", Tap);
