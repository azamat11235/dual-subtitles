/**
 * Drawing the two subtitle lines over the player.
 *
 * Both lines share one timeline. A segment carries the text of both languages,
 * and every frame looks up exactly one segment, so the lines can never switch at
 * different moments — synchronisation is a property of the data here, not
 * something the caller has to keep arranging.
 */
(() => {
  const DS = (window.DS = window.DS || {});

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

      player.appendChild(root);
      this.root = root;

      this.resizeObserver = new ResizeObserver(() => this.applyScale());
      this.resizeObserver.observe(player);

      this.applySettings(this.settings);
      this.start();
    }

    detach() {
      this.stop();
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.root) {
        this.root.removeEventListener('mouseenter', this.onEnter);
        this.root.removeEventListener('mouseleave', this.onLeave);
        this.root.removeEventListener('click', this.onClick);
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

    // A click on the subtitles should behave like a click on the video — but
    // must not get in the way of selecting the text with the mouse.
    onClick = () => {
      if (String(window.getSelection() || '').length) return;
      if (!this.video) return;
      if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause();
    };

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
      st.setProperty('--ds-bottom', `${s.bottomOffset}%`);
      st.setProperty('--ds-bg', `rgba(8, 8, 8, ${s.background / 100})`);
      st.setProperty('--ds-primary-color', s.primaryColor);
      st.setProperty('--ds-secondary-color', s.secondaryColor);
      this.lines.primary.style.order = s.swapOrder ? '2' : '1';
      this.lines.secondary.style.order = s.swapOrder ? '1' : '2';
      this.root.classList.toggle('ds-overlay--interactive', !!s.pauseOnHover);
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
