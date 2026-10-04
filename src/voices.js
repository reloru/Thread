// Aura-2 voices on Workers AI. The 40 English and 10 Spanish names are the speaker enums of the
// @cf/deepgram/aura-2-en and @cf/deepgram/aura-2-es model schemas; the service rejects any other
// speaker (Deepgram's own table lists more voices, such as selene, that Workers AI does not serve).
// Gender, age, accent and traits are from Deepgram's voice table:
// https://developers.deepgram.com/docs/tts-models

export const VOICE_MODELS = {
	en: "@cf/deepgram/aura-2-en",
	es: "@cf/deepgram/aura-2-es",
};

export const DEFAULT_VOICE = "luna";

export const VOICES = [
	{ id: "amalthea", lang: "en", gender: "feminine", age: "Young Adult", accent: "Filipino", traits: ["Engaging", "Natural", "Cheerful"] },
	{ id: "andromeda", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Casual", "Expressive", "Comfortable"] },
	{ id: "apollo", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Confident", "Comfortable", "Casual"] },
	{ id: "arcas", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Natural", "Smooth", "Clear", "Comfortable"] },
	{ id: "aries", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Warm", "Energetic", "Caring"] },
	{ id: "asteria", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Clear", "Confident", "Knowledgeable", "Energetic"] },
	{ id: "athena", lang: "en", gender: "feminine", age: "Mature", accent: "American", traits: ["Calm", "Smooth", "Professional"] },
	{ id: "atlas", lang: "en", gender: "masculine", age: "Mature", accent: "American", traits: ["Enthusiastic", "Confident", "Approachable", "Friendly"] },
	{ id: "aurora", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Cheerful", "Expressive", "Energetic"] },
	{ id: "callista", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Clear", "Energetic", "Professional", "Smooth"] },
	{ id: "cora", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Smooth", "Melodic", "Caring"] },
	{ id: "cordelia", lang: "en", gender: "feminine", age: "Young Adult", accent: "American", traits: ["Approachable", "Warm", "Polite"] },
	{ id: "delia", lang: "en", gender: "feminine", age: "Young Adult", accent: "American", traits: ["Casual", "Friendly", "Cheerful", "Breathy"] },
	{ id: "draco", lang: "en", gender: "masculine", age: "Adult", accent: "British", traits: ["Warm", "Approachable", "Trustworthy", "Baritone"] },
	{ id: "electra", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Professional", "Engaging", "Knowledgeable"] },
	{ id: "harmonia", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Empathetic", "Clear", "Calm", "Confident"] },
	{ id: "helena", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Caring", "Natural", "Positive", "Friendly", "Raspy"] },
	{ id: "hera", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Smooth", "Warm", "Professional"] },
	{ id: "hermes", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Expressive", "Engaging", "Professional"] },
	{ id: "hyperion", lang: "en", gender: "masculine", age: "Adult", accent: "Australian", traits: ["Caring", "Warm", "Empathetic"] },
	{ id: "iris", lang: "en", gender: "feminine", age: "Young Adult", accent: "American", traits: ["Cheerful", "Positive", "Approachable"] },
	{ id: "janus", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Southern", "Smooth", "Trustworthy"] },
	{ id: "juno", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Natural", "Engaging", "Melodic", "Breathy"] },
	{ id: "jupiter", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Expressive", "Knowledgeable", "Baritone"] },
	{ id: "luna", lang: "en", gender: "feminine", age: "Young Adult", accent: "American", traits: ["Friendly", "Natural", "Engaging"] },
	{ id: "mars", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Smooth", "Patient", "Trustworthy", "Baritone"] },
	{ id: "minerva", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Positive", "Friendly", "Natural"] },
	{ id: "neptune", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Professional", "Patient", "Polite"] },
	{ id: "odysseus", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Calm", "Smooth", "Comfortable", "Professional"] },
	{ id: "ophelia", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Expressive", "Enthusiastic", "Cheerful"] },
	{ id: "orion", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Approachable", "Comfortable", "Calm", "Polite"] },
	{ id: "orpheus", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Professional", "Clear", "Confident", "Trustworthy"] },
	{ id: "pandora", lang: "en", gender: "feminine", age: "Adult", accent: "British", traits: ["Smooth", "Calm", "Melodic", "Breathy"] },
	{ id: "phoebe", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Energetic", "Warm", "Casual"] },
	{ id: "pluto", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Smooth", "Calm", "Empathetic", "Baritone"] },
	{ id: "saturn", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Knowledgeable", "Confident", "Baritone"] },
	{ id: "thalia", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Clear", "Confident", "Energetic", "Enthusiastic"] },
	{ id: "theia", lang: "en", gender: "feminine", age: "Adult", accent: "Australian", traits: ["Expressive", "Polite", "Sincere"] },
	{ id: "vesta", lang: "en", gender: "feminine", age: "Adult", accent: "American", traits: ["Natural", "Expressive", "Patient", "Empathetic"] },
	{ id: "zeus", lang: "en", gender: "masculine", age: "Adult", accent: "American", traits: ["Deep", "Trustworthy", "Smooth"] },
	{ id: "sirio", lang: "es", gender: "masculine", age: "Adult", accent: "Mexican", traits: ["Calm", "Professional", "Comfortable", "Empathetic", "Baritone"] },
	{ id: "nestor", lang: "es", gender: "masculine", age: "Adult", accent: "Peninsular", traits: ["Calm", "Professional", "Approachable", "Clear", "Confident"] },
	{ id: "carina", lang: "es", gender: "feminine", age: "Adult", accent: "Peninsular", traits: ["Professional", "Raspy", "Energetic", "Breathy", "Confident"] },
	{ id: "celeste", lang: "es", gender: "feminine", age: "Young Adult", accent: "Colombian", traits: ["Clear", "Energetic", "Positive", "Friendly", "Enthusiastic"] },
	{ id: "alvaro", lang: "es", gender: "masculine", age: "Adult", accent: "Peninsular", traits: ["Calm", "Professional", "Clear", "Knowledgeable", "Approachable"] },
	{ id: "diana", lang: "es", gender: "feminine", age: "Adult", accent: "Peninsular", traits: ["Professional", "Confident", "Expressive", "Polite", "Knowledgeable"] },
	{ id: "aquila", lang: "es", gender: "masculine", age: "Adult", accent: "Latin American", traits: ["Expressive", "Enthusiastic", "Confident", "Casual", "Comfortable"] },
	{ id: "selena", lang: "es", gender: "feminine", age: "Young Adult", accent: "Latin American", traits: ["Approachable", "Casual", "Friendly", "Calm", "Positive"] },
	{ id: "estrella", lang: "es", gender: "feminine", age: "Mature", accent: "Mexican", traits: ["Approachable", "Natural", "Calm", "Comfortable", "Expressive"] },
	{ id: "javier", lang: "es", gender: "masculine", age: "Adult", accent: "Mexican", traits: ["Approachable", "Professional", "Friendly", "Comfortable", "Calm"] },
];

export const voiceById = (id) => VOICES.find((v) => v.id === id);
