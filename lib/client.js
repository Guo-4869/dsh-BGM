window.__ModuleLoader__.load({
	id: "dsh-bgm",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * dsh-bgm — client half.
		 *
		 * A resident background-music player. The rules that shape this code:
		 *
		 *  1. Sound cannot start without a user gesture. Chromium rejects an
		 *     unmuted `play()` on a page nobody has touched, so the first
		 *     pointerdown/keydown on the page is the unlock.
		 *  2. The intro animation plays its own audio, so BGM waits until the
		 *     intro overlay is gone (bounded, so a missing overlay cannot strand
		 *     the player).
		 *  3. The folder is the playlist: it is re-read when playback starts and
		 *     at the end of every lap, so added/removed files apply without a
		 *     restart.
		 *  4. Manual pause and "window hidden" pause are different states. Hidden
		 *     is transient (resume on return); manual is a decision the user made
		 *     (stay paused until they say otherwise). Conflating them means the
		 *     music restarts by itself after a minimize.
		 *
		 * Everything here is plain DOM: no slots, no React, no host service
		 * beyond the three read-mostly routes in ../index.js.
		 */

		const API = "/dsh-bgm";
		const STORE_KEY = "dsh-bgm:settings";
		const LOG = "[dsh-bgm]";
		/** How long to wait for the intro overlay before playing regardless. */
		const INTRO_WAIT_MS = 90_000;

		/** How long a press must be held before it becomes a drag, not a tap. */
		const LONG_PRESS_MS = 380;
		/** Movement before the timer fires that turns the press back into a tap. */
		const TAP_SLOP_PX = 8;

		/**
		 * @type {{ volume: number, muted: boolean, pos: { x: number, y: number } | null }}
		 * `pos` is the pill's top-left corner in viewport pixels; null means
		 * "use the default corner".
		 */
		const settings = { volume: 0.35, muted: false, pos: null };
		/** @type {HTMLAudioElement | null} */
		let audio = null;
		/** @type {HTMLElement | null} */
		let uiWrap = null;
		/** @type {Array<{ name: string, title: string, url: string }>} */
		let tracks = [];
		let index = 0;
		let unlocked = false;
		let started = false;
		/** The user asked for silence; only the user can undo this. */
		let paused = false;
		/** Set while the intro overlay is still on screen. */
		let waitingForIntro = false;
		let mounted = false;

		function narrate(text) {
			try {
				console.log(LOG + " " + text);
			} catch {
				/* a logging failure must never break playback */
			}
		}

		/** A stored position, or null when it is missing or malformed. */
		function readPos(value) {
			if (value === null || typeof value !== "object") return null;
			const x = value.x;
			const y = value.y;
			if (typeof x !== "number" || !Number.isFinite(x)) return null;
			if (typeof y !== "number" || !Number.isFinite(y)) return null;
			return { x: Math.round(x), y: Math.round(y) };
		}

		function adopt(value) {
			if (value === null || typeof value !== "object") return;
			if (typeof value.volume === "number" && Number.isFinite(value.volume)) {
				settings.volume = Math.min(1, Math.max(0, value.volume));
			}
			if (typeof value.muted === "boolean") settings.muted = value.muted;
			const pos = readPos(value.pos);
			if (pos !== null) settings.pos = pos;
		}

		function loadSettings() {
			try {
				const raw = localStorage.getItem(STORE_KEY);
				if (raw === null) return;
				adopt(JSON.parse(raw));
			} catch {
				/* a corrupt value means "keep the defaults" */
			}
		}

		function saveSettings() {
			try {
				localStorage.setItem(STORE_KEY, JSON.stringify({ volume: settings.volume, muted: settings.muted }));
			} catch {
				/* private mode, quota — not worth failing playback over */
			}
			persistSettings();
		}

		/**
		 * The durable copy of the settings.
		 *
		 * localStorage is a fast local cache, not the source of truth: it is
		 * scoped to `host:port` and the desktop client comes up on a new port
		 * every launch, so a value kept only there is gone after a restart.
		 */
		let persistTimer = 0;
		function persistSettings() {
			if (persistTimer !== 0) window.clearTimeout(persistTimer);
			persistTimer = window.setTimeout(() => {
				persistTimer = 0;
				const body = JSON.stringify({ volume: settings.volume, muted: settings.muted, pos: settings.pos });
				try {
					void fetch(API + "/settings.json", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
						keepalive: true,
					}).catch(() => {});
				} catch {
					/* a failed save must never break the player */
				}
			}, 250);
		}

		/** Adopt the host's stored settings when they arrive. */
		async function loadHostSettings() {
			try {
				const response = await fetch(API + "/settings.json", { cache: "no-store" });
				if (!response.ok) return;
				const value = await response.json();
				adopt(value);
				if (audio !== null) audio.volume = effectiveVolume();
				applyPosition(settings.pos);
				syncUi();
			} catch {
				/* host settings are an upgrade over the cache, not a requirement */
			}
		}

		/** @returns {Promise<Array<{ name: string, title: string, url: string }>>} */
		async function fetchTracks() {
			try {
				const response = await fetch(API + "/list.json", { cache: "no-store" });
				if (!response.ok) return [];
				const payload = await response.json();
				if (!Array.isArray(payload.tracks)) return [];
				return payload.tracks.filter((item) => item && typeof item.url === "string");
			} catch (error) {
				narrate("list failed: " + String(error));
				return [];
			}
		}

		/** True while the boot animation's overlay is on screen. */
		function introOnScreen() {
			try {
				return document.querySelector('[class*="dba-root"]') !== null;
			} catch {
				return false;
			}
		}

		function effectiveVolume() {
			return settings.muted ? 0 : settings.volume;
		}

		function currentTrack() {
			if (tracks.length === 0) return null;
			return tracks[((index % tracks.length) + tracks.length) % tracks.length];
		}

		function isActuallyPlaying() {
			return audio !== null && audio.paused === false;
		}

		function syncUi() {
			const wrap = document.getElementById("dsh-bgm-ui");
			if (wrap === null) return;
			const label = wrap.querySelector("[data-dsh-bgm-label]");
			const mute = wrap.querySelector("[data-dsh-bgm-mute]");
			const play = wrap.querySelector("[data-dsh-bgm-play]");
			const range = wrap.querySelector("[data-dsh-bgm-volume]");
			const current = currentTrack();
			if (label !== null) {
				if (tracks.length === 0) label.textContent = "无音乐（往 ~/.dsh/bgm 放文件）";
				else {
					const parts = [];
					if (settings.muted) parts.push("已静音");
					if (paused) parts.push("已暂停");
					parts.push(current === null ? "" : current.title);
					label.textContent = parts.filter(Boolean).join(" · ");
				}
			}
			if (mute !== null) {
				mute.textContent = settings.muted ? "🔇" : "🎵";
				mute.title = settings.muted ? "取消静音" : "静音";
			}
			if (play !== null) {
				play.textContent = isActuallyPlaying() ? "⏸" : "▶";
				play.title = isActuallyPlaying() ? "暂停" : "播放";
			}
			if (range !== null) {
				const value = Math.round(settings.volume * 100);
				if (range.value !== String(value)) range.value = String(value);
			}
		}

		function makeButton(text, title, onClick) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.title = title;
			button.style.cssText =
				"all:unset;cursor:pointer;font-size:13px;line-height:1;padding:3px 5px;border-radius:6px;text-align:center";
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				onClick();
			});
			return button;
		}

		/** The pill's own footprint, for keeping it on screen. */
		function uiSize() {
			if (uiWrap === null) return { width: 0, height: 0 };
			return { width: uiWrap.offsetWidth || 0, height: uiWrap.offsetHeight || 0 };
		}

		/** Keep the pill fully visible: a stored spot may predate a smaller window. */
		function clampPos(x, y) {
			const size = uiSize();
			const vw = typeof window.innerWidth === "number" && window.innerWidth > 0 ? window.innerWidth : 1280;
			const vh = typeof window.innerHeight === "number" && window.innerHeight > 0 ? window.innerHeight : 800;
			const maxX = Math.max(8, vw - size.width - 8);
			const maxY = Math.max(8, vh - size.height - 8);
			return {
				x: Math.round(Math.min(Math.max(8, x), maxX)),
				y: Math.round(Math.min(Math.max(8, y), maxY)),
			};
		}

		function applyPosition(pos) {
			if (uiWrap === null || pos === null) return;
			const clamped = clampPos(pos.x, pos.y);
			settings.pos = clamped;
			uiWrap.style.left = clamped.x + "px";
			uiWrap.style.top = clamped.y + "px";
			uiWrap.style.right = "auto";
			uiWrap.style.bottom = "auto";
		}

		/**
		 * Long-press to drag.
		 *
		 * A short press must stay a tap on whatever it hit, so the drag does not
		 * begin until the press has been held for LONG_PRESS_MS *and* the pointer
		 * has not wandered past TAP_SLOP_PX. The volume slider is exempt: it is
		 * its own drag surface, and fighting it would make the volume unusable.
		 */
		function attachDrag(wrap) {
			let press = null;
			let suppressClick = false;

			const resetVisual = () => {
				wrap.style.cursor = "grab";
				wrap.style.transform = "";
				wrap.style.boxShadow = "";
			};

			const detach = () => {
				window.removeEventListener("pointermove", onMove, true);
				window.removeEventListener("pointerup", onUp, true);
				window.removeEventListener("pointercancel", onUp, true);
			};

			const finish = () => {
				if (press === null) return;
				window.clearTimeout(press.timer);
				const wasDragging = press.dragging;
				press = null;
				detach();
				resetVisual();
				if (wasDragging) {
					// The click that follows a drag must not press a button.
					suppressClick = true;
					window.setTimeout(() => {
						suppressClick = false;
					}, 300);
					saveSettings();
				}
			};

			const onMove = (event) => {
				if (press === null) return;
				const dx = event.clientX - press.startX;
				const dy = event.clientY - press.startY;
				if (!press.dragging) {
					if (Math.hypot(dx, dy) > TAP_SLOP_PX) finish();
					return;
				}
				const next = clampPos(press.originX + dx, press.originY + dy);
				settings.pos = next;
				wrap.style.left = next.x + "px";
				wrap.style.top = next.y + "px";
				wrap.style.right = "auto";
				wrap.style.bottom = "auto";
			};

			const onUp = () => finish();

			wrap.addEventListener("pointerdown", (event) => {
				if (typeof event.button === "number" && event.button !== 0) return;
				const tag = event.target && event.target.tagName;
				// The range input owns its own pointer handling.
				if (tag === "INPUT") return;
				const rect = wrap.getBoundingClientRect();
				press = {
					timer: 0,
					startX: event.clientX,
					startY: event.clientY,
					originX: rect.left,
					originY: rect.top,
					dragging: false,
				};
				press.timer = window.setTimeout(() => {
					if (press === null) return;
					press.dragging = true;
					wrap.style.cursor = "grabbing";
					wrap.style.transform = "scale(1.04)";
					wrap.style.opacity = "1";
					wrap.style.boxShadow = "0 8px 26px rgba(0,0,0,.42)";
				}, LONG_PRESS_MS);
				window.addEventListener("pointermove", onMove, true);
				window.addEventListener("pointerup", onUp, true);
				window.addEventListener("pointercancel", onUp, true);
			});

			wrap.addEventListener(
				"click",
				(event) => {
					if (!suppressClick) return;
					suppressClick = false;
					event.stopPropagation();
					event.preventDefault();
				},
				true,
			);

			resetVisual();
		}

		function buildUi() {
			if (document.getElementById("dsh-bgm-ui") !== null) return;
			const wrap = document.createElement("div");
			wrap.id = "dsh-bgm-ui";
			wrap.style.cssText = [
				"position:fixed",
				// Bottom-LEFT, lifted clear of the sidebar footer (设置 / 🎛 / 🎞):
				// a pill pinned to the very corner sits on top of those icons.
				"left:14px",
				"bottom:64px",
				"z-index:2147483000",
				"display:flex",
				"align-items:center",
				"gap:6px",
				"padding:6px 10px",
				"border-radius:999px",
				"background:rgba(18,20,28,.72)",
				"backdrop-filter:blur(10px)",
				"-webkit-backdrop-filter:blur(10px)",
				"border:1px solid rgba(255,255,255,.10)",
				"color:#e8ecf5",
				"font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif",
				"opacity:.32",
				"transition:opacity .18s ease",
				"user-select:none",
			].join(";");
			wrap.addEventListener("mouseenter", () => {
				wrap.style.opacity = "1";
			});
			wrap.addEventListener("mouseleave", () => {
				wrap.style.opacity = ".32";
			});

			const prev = makeButton("⏮", "上一首", () => {
				void step(-1);
			});
			prev.dataset.dshBgmPrev = "1";

			const play = makeButton("▶", "播放/暂停", () => {
				void togglePlay();
			});
			play.dataset.dshBgmPlay = "1";

			const next = makeButton("⏭", "下一首", () => {
				void step(1);
			});
			next.dataset.dshBgmNext = "1";

			const mute = makeButton("🎵", "静音", () => {
				settings.muted = !settings.muted;
				saveSettings();
				if (audio !== null) audio.volume = effectiveVolume();
				syncUi();
			});
			mute.dataset.dshBgmMute = "1";

			const range = document.createElement("input");
			range.type = "range";
			range.min = "0";
			range.max = "100";
			range.step = "1";
			range.style.cssText = "width:64px;accent-color:#7aa2ff;cursor:pointer";
			range.dataset.dshBgmVolume = "1";
			range.addEventListener("input", () => {
				settings.volume = Number(range.value) / 100;
				if (settings.volume > 0 && settings.muted) settings.muted = false;
				saveSettings();
				if (audio !== null) audio.volume = effectiveVolume();
				syncUi();
			});

			const label = document.createElement("span");
			label.dataset.dshBgmLabel = "1";
			label.style.cssText = "max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9";

			wrap.appendChild(prev);
			wrap.appendChild(play);
			wrap.appendChild(next);
			wrap.appendChild(mute);
			wrap.appendChild(range);
			wrap.appendChild(label);
			document.body.appendChild(wrap);
			uiWrap = wrap;
			attachDrag(wrap);
			applyPosition(settings.pos);
			window.addEventListener("resize", () => {
				applyPosition(settings.pos);
			});
			syncUi();
		}

		/**
		 * The track currently loaded into the element.
		 *
		 * Assigning `audio.src` resets the playhead to 0, so it must happen on a
		 * REAL track change and nowhere else. Re-assigning the same URL (what a
		 * resume used to do) restarts the song from the beginning — the reported
		 * "pause, come back, it plays from the top" defect.
		 */
		let loadedUrl = "";

		/** Load the track at `index`; plays only when allowed to make noise. */
		async function loadTrack(shouldPlay, options = {}) {
			if (audio === null) return;
			if (tracks.length === 0) {
				tracks = await fetchTracks();
			}
			const track = currentTrack();
			if (track === null) {
				syncUi();
				return;
			}
			audio.volume = effectiveVolume();
			if (loadedUrl !== track.url) {
				audio.src = track.url;
				loadedUrl = track.url;
			} else if (options.restart === true) {
				// Same track, asked to start over (a skip that wraps onto itself,
				// or a track that just ended): seek instead of reloading.
				try {
					audio.currentTime = 0;
				} catch {
					/* an element that cannot seek will restart on play() anyway */
				}
			}
			if (!shouldPlay) {
				syncUi();
				return;
			}
			if (document.hidden) return;
			try {
				await audio.play();
				narrate("playing " + track.name);
			} catch (error) {
				// A rejected play means the gesture budget is gone: wait for the
				// next one instead of spamming play() in a loop.
				narrate("play rejected: " + String(error));
				unlocked = false;
				armUnlock();
			}
			syncUi();
		}

		/** Move by `delta` tracks, wrapping around, and keep the play/pause state. */
		async function step(delta) {
			if (tracks.length === 0) {
				tracks = await fetchTracks();
				if (tracks.length === 0) {
					syncUi();
					return;
				}
			}
			const size = tracks.length;
			index = (((index + delta) % size) + size) % size;
			// Skip is an explicit intent to listen: never leave the player
			// silently pointing at a new track while paused.
			paused = false;
			await loadTrack(true, { restart: true });
		}

		async function togglePlay() {
			if (audio === null) return;
			if (audio.paused) {
				paused = false;
				if (!started) await startWhenQuiet();
				else await loadTrack(true);
				return;
			}
			paused = true;
			audio.pause();
			syncUi();
		}

		/** One track finished: advance, and re-read the folder at the wrap. */
		async function advance() {
			if (tracks.length === 0) return;
			index += 1;
			if (index >= tracks.length) {
				const fresh = await fetchTracks();
				if (fresh.length > 0) tracks = fresh;
				index = 0;
			}
			await loadTrack(true, { restart: true });
		}

		function armUnlock() {
			const unlock = () => {
				if (unlocked) return;
				unlocked = true;
				window.removeEventListener("pointerdown", unlock, true);
				window.removeEventListener("keydown", unlock, true);
				void startWhenQuiet();
			};
			window.addEventListener("pointerdown", unlock, true);
			window.addEventListener("keydown", unlock, true);
		}

		async function startWhenQuiet() {
			if (started) {
				// Already running: a resume after a transient pause.
				await loadTrack(!paused);
				return;
			}
			started = true;
			tracks = await fetchTracks();
			syncUi();
			if (tracks.length === 0) {
				narrate("no tracks in the folder yet");
				return;
			}
			if (!introOnScreen()) {
				if (!paused) await loadTrack(true);
				return;
			}
			waitingForIntro = true;
			const began = Date.now();
			const timer = window.setInterval(() => {
				const overdue = Date.now() - began > INTRO_WAIT_MS;
				if (introOnScreen() && !overdue) return;
				window.clearInterval(timer);
				waitingForIntro = false;
				void loadTrack(!paused);
			}, 500);
		}

		function mount() {
			if (mounted) return;
			mounted = true;
			loadSettings();
			audio = document.createElement("audio");
			audio.preload = "auto";
			audio.addEventListener("ended", () => {
				void advance();
			});
			audio.addEventListener("play", () => {
				syncUi();
			});
			audio.addEventListener("pause", () => {
				syncUi();
			});
			audio.addEventListener("error", () => {
				narrate("media error on " + audio.currentSrc);
				window.setTimeout(() => {
					void advance();
				}, 1500);
			});

			const attach = () => {
				buildUi();
				armUnlock();
			};
			if (document.body !== null) attach();
			else document.addEventListener("DOMContentLoaded", attach, { once: true });

			document.addEventListener("visibilitychange", () => {
				if (audio === null) return;
				if (document.hidden) audio.pause();
				else if (!paused && unlocked && started) void loadTrack(true);
			});

			void loadHostSettings();
		}

		function apply() {
			if (window.__dshBgmMounted === true) return;
			window.__dshBgmMounted = true;
			mount();
		}

		exports.apply = apply;
		return module.exports;
	},
});
