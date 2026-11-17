// Full-screen image viewer for attached images, Python figures and page screenshots. Pinch or double-tap to
// zoom, drag to move a zoomed image, tap the background or × to close. Share hands the image to the share sheet
// (iPhone: Save Image), or downloads it where the browser can't share files.

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;

/** The image file of a data: URL, for sharing. Null for anything else. */
export function imageFile(src, name = "image") {
	const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.*)$/s.exec(src || "");
	if (!m) return null;
	const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
	return new File([bytes], `${name}.${m[2] === "jpeg" ? "jpg" : m[2]}`, { type: m[1] });
}

/**
 * Where a zoomed image may be moved: along an axis where it is smaller than the viewer it stays centred, and where
 * it is larger its edges can go as far as the viewer's edges. width, height: the image at scale 1; boxW, boxH: the viewer.
 */
export function clampOffset(scale, x, y, width, height, boxW, boxH) {
	const maxX = Math.max(0, (width * scale - boxW) / 2);
	const maxY = Math.max(0, (height * scale - boxH) / 2);
	// + 0 turns -0 into 0.
	return { x: Math.max(-maxX, Math.min(maxX, x)) + 0, y: Math.max(-maxY, Math.min(maxY, y)) + 0 };
}

/** deps: { root, img, close, share, onOpen, onClose, deliver, toast } */
export function createViewer({ root, img, close, share, onOpen, onClose, deliver, toast }) {
	const view = { scale: 1, x: 0, y: 0 };
	const pointers = new Map();
	let pinch = null;
	let drag = null;
	let lastTap = 0;
	let moved = false;
	// Where the last touch began: with pointer capture, later events are aimed at the viewer itself.
	let downOnImage = false;
	let alt = "";

	function apply() {
		img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
		root.classList.toggle("zoomed", view.scale > 1.01);
	}

	function set(scale, x, y) {
		view.scale = Math.max(1, Math.min(MAX_SCALE, scale));
		const fit = clampOffset(view.scale, x, y, img.offsetWidth, img.offsetHeight, root.clientWidth, root.clientHeight);
		view.x = view.scale === 1 ? 0 : fit.x;
		view.y = view.scale === 1 ? 0 : fit.y;
		apply();
	}

	// Zooms around a point on screen, so what is under the fingers stays there.
	function zoomAt(scale, cx, cy) {
		const rect = root.getBoundingClientRect();
		const px = cx - rect.left - rect.width / 2;
		const py = cy - rect.top - rect.height / 2;
		const k = Math.max(1, Math.min(MAX_SCALE, scale)) / view.scale;
		set(view.scale * k, px - (px - view.x) * k, py - (py - view.y) * k);
	}

	function open(src, description = "") {
		alt = description;
		img.src = src;
		img.alt = description || "Image";
		share.hidden = !src.startsWith("data:image/");
		set(1, 0, 0);
		root.hidden = false;
		root.inert = false;
		requestAnimationFrame(() => root.classList.add("open"));
		onOpen();
		close.focus();
	}

	function hide() {
		if (root.hidden) return;
		root.classList.remove("open");
		root.inert = true;
		root.hidden = true;
		img.removeAttribute("src");
		pointers.clear();
		pinch = drag = null;
		onClose();
	}

	const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

	root.addEventListener("pointerdown", (e) => {
		if (e.target.closest("button")) return;
		root.setPointerCapture?.(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		moved = false;
		downOnImage = e.target === img;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = { d: distance(a, b), scale: view.scale, mid: middle(a, b) };
			drag = null;
		} else if (pointers.size === 1) {
			drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
		}
	});

	root.addEventListener("pointermove", (e) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && pointers.size >= 2) {
			const [a, b] = [...pointers.values()];
			const mid = middle(a, b);
			zoomAt((pinch.scale * distance(a, b)) / pinch.d, mid.x, mid.y);
			moved = true;
		} else if (drag && view.scale > 1) {
			const dx = e.clientX - drag.x;
			const dy = e.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
			set(view.scale, drag.vx + dx, drag.vy + dy);
		} else if (drag && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 8) {
			moved = true;
		}
	});

	const end = (e) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (pointers.size === 1) {
			const [p] = [...pointers.values()];
			drag = { x: p.x, y: p.y, vx: view.x, vy: view.y };
			return;
		}
		drag = null;
		if (moved || e.type === "pointercancel") return;
		// A tap: twice on the image zooms in or back out; once on the background closes.
		const now = performance.now();
		if (downOnImage) {
			if (now - lastTap < DOUBLE_TAP_MS) {
				lastTap = 0;
				if (view.scale > 1.01) set(1, 0, 0);
				else zoomAt(2.5, e.clientX, e.clientY);
			} else lastTap = now;
		} else if (view.scale <= 1.01) hide();
	};
	root.addEventListener("pointerup", end);
	root.addEventListener("pointercancel", end);
	// Desktop: the wheel zooms.
	root.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			zoomAt(view.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
		},
		{ passive: false },
	);

	close.addEventListener("click", hide);
	share.addEventListener("click", async () => {
		const file = imageFile(img.src, (alt || "image").replace(/[^\w -]+/g, "").trim().slice(0, 40) || "image");
		if (!file) return;
		const result = await deliver(file);
		if (result === "saved") toast(`Saved ${file.name}`);
		else if (result === "blocked") toast("Couldn't open the share sheet. Try again.");
	});

	return {
		open,
		close: hide,
		get isOpen() {
			return !root.hidden;
		},
	};
}
