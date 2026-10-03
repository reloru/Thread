// Model parameter handling shared by the browser and the Worker (imported as ../public/params.js).

export class ParamError extends Error {}

const RESERVED = new Set(["messages", "prompt", "model", "stream", "requests", "input"]);

export function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Keys accepted at the top level of a request's params for this model. */
export function allowedKeys(model) {
	const keys = new Set(model.extraKeys);
	for (const c of model.controls) keys.add(c.path || c.key);
	return [...keys].sort();
}

/** Validates wire-format params against the model's controls and extra keys. Throws ParamError. */
export function sanitizeParams(input, model) {
	if (input === undefined || input === null) return {};
	if (!isPlainObject(input)) throw new ParamError("params must be an object.");

	const top = new Map();
	const nested = new Map();
	for (const c of model.controls) (c.path ? nested : top).set(c.key, c);

	const out = {};
	for (const [key, value] of Object.entries(input)) {
		if (RESERVED.has(key)) throw new ParamError(`${key} cannot be set.`);
		if (key === "chat_template_kwargs" && nested.size) {
			if (!isPlainObject(value)) throw new ParamError("chat_template_kwargs must be an object.");
			const kwargs = {};
			for (const [k, v] of Object.entries(value)) {
				const spec = nested.get(k);
				if (!spec) throw new ParamError(`chat_template_kwargs.${k} is not supported by ${model.name}.`);
				kwargs[k] = checkValue(spec, v, `chat_template_kwargs.${k}`);
			}
			out.chat_template_kwargs = kwargs;
			continue;
		}
		const spec = top.get(key);
		if (spec) out[key] = checkValue(spec, value, key);
		else if (model.extraKeys.includes(key)) out[key] = value;
		else throw new ParamError(`${key} is not a parameter of ${model.name}.`);
	}
	return out;
}

function checkValue(spec, value, name) {
	const fail = (why) => {
		throw new ParamError(`${name} ${why}.`);
	};
	const inRange = (v) => (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
	const range = spec.min !== undefined && spec.max !== undefined ? ` between ${spec.min} and ${spec.max}` : "";

	switch (spec.type) {
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value) || !inRange(value)) fail(`must be a number${range}`);
			return value;
		case "integer":
			if (!Number.isSafeInteger(value) || !inRange(value)) fail(`must be an integer${range}`);
			return value;
		case "enum":
			if (!spec.options.includes(value)) fail(`must be one of ${spec.options.join(", ")}`);
			return value;
		case "boolean":
			if (typeof value !== "boolean") fail("must be true or false");
			return value;
		case "stop": {
			const list = typeof value === "string" ? [value] : value;
			if (!Array.isArray(list) || list.length < 1 || list.length > spec.maxItems) {
				fail(`must be a string or 1 to ${spec.maxItems} strings`);
			}
			if (!list.every((s) => typeof s === "string" && s.length > 0)) fail("entries must be non-empty strings");
			return list;
		}
		case "format":
			if (!isPlainObject(value)) fail('must be an object like {"type": "json_object"}');
			if (value.type === "json_schema") {
				if (!isPlainObject(value.json_schema) || typeof value.json_schema.name !== "string") {
					fail("needs a json_schema object with a name");
				}
				return value;
			}
			if (!spec.options.includes(value.type)) fail(`type must be one of ${[...spec.options, "json_schema"].join(", ")}`);
			return { type: value.type };
		case "bias":
			if (!isPlainObject(value)) fail("must be an object mapping token IDs to numbers");
			for (const [token, bias] of Object.entries(value)) {
				if (!/^\d+$/.test(token)) fail("keys must be token IDs");
				if (typeof bias !== "number" || !Number.isFinite(bias) || bias < -100 || bias > 100) {
					fail("values must be numbers from -100 to 100");
				}
			}
			return value;
		default:
			fail("has an unsupported type");
	}
}

/**
 * Converts stored settings ({ values, json }) into validated wire params.
 * Control values are applied first; Advanced JSON fields override them.
 */
export function toWire(model, entry) {
	const values = entry?.values || {};
	const out = {};
	for (const c of model.controls) {
		if (!Object.hasOwn(values, c.key)) continue;
		const v = values[c.key];
		let wire = v;
		if (c.type === "stop") {
			wire = String(v)
				.split("\n")
				.map((s) => s.replace(/\r$/, ""))
				.filter((s) => s.length > 0);
			if (!wire.length) continue;
		} else if (c.type === "format") {
			wire = { type: v };
		} else if (c.type === "bias") {
			const text = String(v).trim();
			if (!text) continue;
			try {
				wire = JSON.parse(text);
			} catch {
				throw new ParamError(`${c.label}: invalid JSON.`);
			}
		}
		if (c.path) (out[c.path] ??= {})[c.key] = wire;
		else out[c.key] = wire;
	}

	const text = (entry?.json || "").trim();
	if (text) {
		let extra;
		try {
			extra = JSON.parse(text);
		} catch (err) {
			throw new ParamError(`Advanced JSON: ${err.message}`);
		}
		if (!isPlainObject(extra)) throw new ParamError("Advanced JSON must be an object.");
		for (const [k, v] of Object.entries(extra)) {
			out[k] = k === "chat_template_kwargs" && isPlainObject(v) && isPlainObject(out[k]) ? { ...out[k], ...v } : v;
		}
	}
	return sanitizeParams(out, model);
}

export function hasCustom(entry) {
	return Boolean(entry && (Object.keys(entry.values || {}).length > 0 || (entry.json || "").trim()));
}
