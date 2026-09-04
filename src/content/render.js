/**
 * Drawing the two subtitle lines over the player.
 *
 * Both lines share one timeline. A segment carries the text of both languages,
 * and every frame looks up exactly one segment, so the lines can never switch at
 * different moments — synchronisation is a property of the data here, not
 * something the caller has to keep arranging.
 *
 * The block can be dragged with the mouse, the way YouTube's own subtitles can.
 * Its position is kept as fractions of the player size, so it survives a resize
 * and the jump into fullscreen.
 */
(() => {
  const DS = (window.DS = window.DS || {});

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** How far the pointer must travel before a press counts as a drag. */
  const DRAG_THRESHOLD = 4;

  /**
   * Keeps the subtitle block inside the player.
   *
   * A pure function: everything comes in as pixels and comes out as fractions of
   * the player size — X the centre of the block, Y its distance from the bottom.
   */
  DS.clampCaptionPosition = function clampCaptionPosition(
    centerX, bottom, contentW, contentH, playerW, playerH, margin = 4
  ) {
    // A block wider than the player cannot fit whichever way it is pushed, so
    // centre it instead of shoving it off one edge.
    const half = contentW / 2;
    const loX = Math.min(half + margin, playerW / 2);
    const hiX = Math.max(playerW - half - margin, playerW / 2);

    const hiY = Math.max(margin, playerH - contentH - margin);

    return {
      x: clamp(centerX, loX, hiX) / playerW,
      y: clamp(bottom, margin, hiY) / playerH
    };
  };

  DS.Renderer = class Renderer {
    constructor() {
      this.player = null;
      this.video = null;
      this.root = null;
      this.lines = { primary: null, secondary: null };
      /** @type {Array<{start:number,end:number,primary:string,secondary:string}>} */
      this.segments = [];
      this.hint = 0;
      this.shown = { primary: null, secondary: null };
      this.settings = { ...DS.DEFAULTS };
      this.rafId = null;
      this.pausedByHover = false;
      this.resizeObserver = null;
      this.press = null;
      this.suppressClick = false;
    }

    attach(player, video) {
      if (this.root && this.player === player) {
        // Same player, but YouTube may swap the <video> during an SPA change.
        this.video = video;
        return;
      }
      this.detach();
      this.player = player;
      this.video = video;

      const root = document.createElement('div');
      root.className = 'ds-overlay';
      root.dataset.dsOverlay = '1';

      const mk = (role) => {
        const line = document.createElement('div');
        line.className = `ds-line ds-line--${role}`;
        const span = document.createElement('span');
        span.className = 'ds-text';
        line.appendChild(span);
        root.appendChild(line);
        return line;
      };
      // DOM order is fixed; the visual order is swapped through CSS order, so
      // the nodes never have to be rebuilt.
      this.lines.primary = mk('primary');
      this.lines.secondary = mk('secondary');

      root.addEventListener('mouseenter', this.onEnter);
      root.addEventListener('mouseleave', this.onLeave);
      root.addEventListener('click', this.onClick);
      root.addEventListener('pointerdown', this.onPointerDown);

      player.appendChild(root);
      this.root = root;

      this.resizeObserver = new ResizeObserver(() => this.applyScale());
      this.resizeObserver.observe(player);

      this.applySettings(this.settings);
      this.start();
    }

    detach() {
      this.stop();
      this.endDrag();
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.root) {
        this.root.removeEventListener('mouseenter', this.onEnter);
        this.root.removeEventListener('mouseleave', this.onLeave);
        this.root.removeEventListener('click', this.onClick);
        this.root.removeEventListener('pointerdown', this.onPointerDown);
        this.root.remove();
      }
      this.root = null;
      this.player = null;
      this.video = null;
      this.shown = { primary: null, secondary: null };
    }

    onEnter = () => {
      if (!this.settings.pauseOnHover || !this.video) return;
      if (!this.video.paused) { this.video.pause(); this.pausedByHover = true; }
    };

    onLeave = () => {
      if (this.pausedByHover && this.video) { this.video.play().catch(() => {}); }
      this.pausedByHover = false;
    };

    // A click on the subtitles should behave like a click on the video — but must
    // not get in the way of selecting the text, and must not fire at the end of a
    // drag.
    onClick = () => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (String(window.getSelection() || '').length) return;
      if (!this.video) return;
      if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause();
    };

    // ------------------------------- dragging --------------------------------

    /**
     * The visible bounds of the text. In its default position the overlay spans
     * the full width of the player, so the limits have to come from the lines
     * themselves rather than from the container.
     */
    contentRect() {
      const rects = ['primary', 'secondary']
        .map((role) => this.lines[role])
        .filter((line) => line.classList.contains('ds-line--visible'))
        .map((line) => line.firstChild.getBoundingClientRect());
      if (!rects.length) return this.root.getBoundingClientRect();
      return {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom))
      };
    }

    onPointerDown = (e) => {
      if (e.button !== 0 || !this.root) return;
      // The threshold is what keeps a short click a click: the press only turns
      // into a drag once the pointer actually moves, so a double click still
      // selects a word and a single one still pauses the video.
      this.press = { startX: e.clientX, startY: e.clientY, dragging: false };
      window.addEventListener('pointermove', this.onPointerMove);
      window.addEventListener('pointerup', this.onPointerUp);
      window.addEventListener('pointercancel', this.onPointerUp);
    };

    onPointerMove = (e) => {
      const p = this.press;
      if (!p) return;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;

      if (!p.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        p.dragging = true;
        // Drop whatever selection managed to start before the threshold.
        window.getSelection()?.removeAllRanges();

        const playerRect = this.player.getBoundingClientRect();
        const rootRect = this.root.getBoundingClientRect();
        const content = this.contentRect();
        p.playerRect = playerRect;
        p.contentW = content.right - content.left;
        p.contentH = content.bottom - content.top;
        // Horizontally the anchor is the centre of the text; vertically it is the
        // bottom of the container, because that is what the CSS `bottom` moves.
        p.centerX = (content.left + content.right) / 2 - playerRect.left;
        p.bottom = playerRect.bottom - rootRect.bottom;
        this.root.classList.add('ds-overlay--dragging');
      }

      const pr = p.playerRect;
      const pos = DS.clampCaptionPosition(
        p.centerX + dx, p.bottom - dy,
        p.contentW, p.contentH,
        pr.width, pr.height
      );
      this.applyPosition(pos.x, pos.y);
      p.last = pos;
      e.preventDefault();
    };

    onPointerUp = () => {
      const p = this.press;
      this.endDrag();
      if (!p?.dragging) return;
      // The click that ends a drag must not pause the video.
      this.suppressClick = true;
      if (p.last) DS.setSettings({ captionX: p.last.x, captionY: p.last.y });
    };

    endDrag() {
      window.removeEventListener('pointermove', this.onPointerMove);
      window.removeEventListener('pointerup', this.onPointerUp);
      window.removeEventListener('pointercancel', this.onPointerUp);
      this.root?.classList.remove('ds-overlay--dragging');
      this.press = null;
    }

    /** Passing null for either coordinate returns the block to its default spot. */
    applyPosition(x, y) {
      if (!this.root) return;
      const custom = x != null && y != null;
      this.root.classList.toggle('ds-overlay--custom', custom);
      if (custom) {
        this.root.style.setProperty('--ds-x', `${x * 100}%`);
        this.root.style.setProperty('--ds-y', `${y * 100}%`);
      }
    }

    /** @param {Array<{start:number,end:number,primary:string,secondary:string}>} segments */
    setSegments(segments) {
      this.segments = segments || [];
      this.hint = 0;
      this.shown = { primary: null, secondary: null };
      this.tick(true);
    }

    clear() {
      this.segments = [];
      this.hint = 0;
      this.shown = { primary: null, secondary: null };
      for (const role of ['primary', 'secondary']) {
        if (this.lines[role]) {
          this.lines[role].firstChild.textContent = '';
          this.lines[role].classList.remove('ds-line--visible');
        }
      }
    }

    applyScale() {
      if (!this.root || !this.player) return;
      const h = this.player.clientHeight || 360;
      const base = Math.max(13, Math.min(46, h * 0.033));
      this.root.style.setProperty('--ds-base', `${base * (this.settings.fontSize / 100)}px`);
    }

    applySettings(s) {
      this.settings = s;
      if (!this.root) return;
      const st = this.root.style;
      st.setProperty('--ds-gap', `${s.lineGap}px`);
      st.setProperty('--ds-bg', `rgba(8, 8, 8, ${s.background / 100})`);
      st.setProperty('--ds-primary-color', s.primaryColor);
      st.setProperty('--ds-secondary-color', s.secondaryColor);
      this.root.classList.toggle('ds-overlay--interactive', !!s.pauseOnHover);
      // While a drag is running the pointer owns the position, not the settings.
      if (!this.press?.dragging) this.applyPosition(s.captionX, s.captionY);
      this.applyScale();
    }

    start() {
      if (this.rafId != null) return;
      const loop = () => { this.tick(); this.rafId = requestAnimationFrame(loop); };
      this.rafId = requestAnimationFrame(loop);
    }

    stop() {
      if (this.rafId != null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    tick(force = false) {
      if (!this.root || !this.video) return;

      // During an ad, currentTime belongs to the ad clip — hide.
      const isAd = this.player.classList.contains('ad-showing') ||
                   this.player.classList.contains('ad-interrupting');
      if (isAd) {
        if (!this.root.classList.contains('ds-overlay--hidden')) {
          this.root.classList.add('ds-overlay--hidden');
        }
        return;
      }
      this.root.classList.remove('ds-overlay--hidden');

      const t = this.video.currentTime * 1000;
      const idx = DS.findActive(this.segments, t, this.hint);
      if (idx >= 0) this.hint = idx;
      const seg = idx >= 0 ? this.segments[idx] : null;

      // One segment feeds both lines within the same frame.
      for (const role of ['primary', 'secondary']) {
        const text = seg ? (seg[role] || '') : '';
        if (!force && text === this.shown[role]) continue;
        this.shown[role] = text;
        const line = this.lines[role];
        line.firstChild.textContent = text;
        line.classList.toggle('ds-line--visible', !!text);
      }
    }
  };
})();
