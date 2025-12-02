/**
 * script.js
 *
 * Component: SiteNav + Demo blocks initializer
 * Purpose:
 *  - Provide a minimal, robust, and accessible navigation behavior for a tiny static site.
 *  - Provide a small demo initializer (initDemoBlocks) to wire demo CTAs, keyboard accessibility,
 *    and an accessible modal placeholder for demos.
 *
 * Responsibilities:
 *  - Mobile navigation toggle (open/close nav).
 *  - Highlight the active navigation link based on the current location.
 *  - Provide a simple public API for init, destroy, toggleNav, and highlightActiveLink.
 *  - Provide initDemoBlocks() and modal utilities for the demo page.
 *
 * Acceptance criteria:
 *  - Works without breaking markup if JS is disabled (graceful degradation).
 *  - Accessible: proper ARIA attributes, keyboard support (Enter/Space/Escape), focus management.
 *  - Defensive: checks for DOM availability, avoids duplicate listeners, cleans up on destroy.
 *
 * Module system:
 *  - UMD-compatible: exports SiteNav for CommonJS, AMD, or as a global window.SiteNav.
 *
 * Public API:
 *  - init(options): initialize behavior (idempotent).
 *  - destroy(): remove all listeners and restore initial state.
 *  - toggleNav(force): open/close nav; optional boolean to explicitly set state.
 *  - highlightActiveLink(opts): re-scan nav links and mark the active one(s).
 *  - initDemoBlocks(): initialize demo CTAs & modal behavior
 *
 * Notes:
 *  - Defensive wiring for ARIA attributes (do not overwrite author-provided values).
 *  - Proper cleanup for idle callbacks and fallback timeouts.
 *  - Modal focus management: simple trap + restore focus to opener.
 */

/* global define, module, exports, window, document, requestIdleCallback, cancelIdleCallback */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SiteNav = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Default configuration.
   * Consumers may pass an options object to init() to override.
   */
  var DEFAULTS = {
    selectors: {
      // Be tolerant: support multiple common conventions used across minimal sites
      nav: '[data-nav], [data-js="nav"], .site-nav, nav',
      navToggle: '[data-nav-toggle], [data-js="nav-toggle"], .nav-toggle, .toggle-nav',
      navPanel: '[data-nav-panel], [data-js="nav-panel"], .nav-panel, .nav__panel',
      navLinks: '[data-nav] a[href], [data-js="nav"] a[href], .nav-list a[href], .nav a[href], nav a[href]'
    },
    classNames: {
      // class added to the panel element when open (many styles target panel)
      panelOpen: 'is-open',
      // legacy name: nav-level class (also used in some markups)
      navOpen: 'is-open',
      activeLink: 'active'
    },
    // The attribute used on toggle button to mark aria-expanded
    ariaExpandedAttr: 'aria-expanded',
    // When opening nav, focus the first link
    focusFirstLinkOnOpen: true,
    // Delay for deferrable work (ms)
    deferDelay: 200,
    // Body class to indicate nav open (optional)
    bodyOpenClass: 'nav-open'
  };

  /**
   * Internal state and listeners container.
   */
  var state = {
    initted: false,
    isOpen: false,
    config: {},
    elements: {
      nav: null,
      panel: null,
      toggles: [],
      links: []
    },
    listeners: {},
    // ids for deferred work so we can cancel on destroy
    _idleId: null,
    _timeoutId: null,
    // stored original attributes so destroy can restore values instead of blindly removing
    _original: {
      nav: {},
      panel: {},
      toggles: [] // array of { el: Element, attrs: { attrName: valueOrNull } }
    },
    // demo-specific state for modal and listeners
    _demo: {
      modal: null,
      isOpen: false,
      lastActive: null,
      listeners: [] // { target, type, handler, capture }
    }
  };

  /**
   * Utility: shallow merge
   */
  function merge(a, b) {
    var out = {};
    for (var k in a) {
      if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    }
    for (var k2 in b) {
      if (Object.prototype.hasOwnProperty.call(b, k2)) out[k2] = b[k2];
    }
    return out;
  }

  /**
   * Safe DOM selectors to avoid DOMException from empty/falsy selectors.
   */
  function safeQuerySelector(selector) {
    try {
      if (!selector || typeof selector !== 'string' || selector.trim() === '') return null;
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function safeQueryAll(selector) {
    try {
      if (!selector || typeof selector !== 'string' || selector.trim() === '') return [];
      return Array.prototype.slice.call(document.querySelectorAll(selector), 0);
    } catch (e) {
      return [];
    }
  }

  /**
   * Ensure a DOM element has an id. If not, generate a stable-ish one.
   * Returns the id.
   */
  function ensureId(el, prefix) {
    if (!el) return '';
    if (el.id) return el.id;
    prefix = prefix || 'site-nav';
    var gen = prefix + '-' + Math.random().toString(36).slice(2, 9);
    el.id = gen;
    return gen;
  }

  /**
   * Normalize a path for comparison (strip origin, index.html, trailing slash).
   * Accepts either a string path or an anchor element/href string.
   */
  function normalizePath(href) {
    if (!href) return '/';
    try {
      // Resolve relative links against the current document location for correct fragment handling
      var url = new URL(href, location.href);
      var path = url.pathname || '/';
      // Remove trailing slash except for root
      if (path.length > 1) path = path.replace(/\/+$/, '');
      // Normalize index pages
      path = path.replace(/\/index\.html$/i, '');
      if (!path) path = '/';
      return path;
    } catch (e) {
      // Fallback: basic handling
      try {
        var p = href.split('?')[0].split('#')[0];
        if (!p) return '/';
        if (p.indexOf('/') !== 0) p = '/' + p;
        if (p.length > 1) p = p.replace(/\/+$/, '');
        p = p.replace(/\/index\.html$/i, '');
        if (!p) p = '/';
        return p;
      } catch (e2) {
        return '/';
      }
    }
  }

  /**
   * Compare link href to current location to determine if it's active.
   * Returns true if active.
   */
  function linkMatchesLocation(linkEl) {
    if (!linkEl || !linkEl.getAttribute) return false;
    var href = linkEl.getAttribute('href');
    if (!href) return false;
    // Support anchors, mailto, tel -> not considered active
    if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0 || href.indexOf('javascript:') === 0) return false;
    var linkPath = normalizePath(href);
    var currentPath = normalizePath(location.href);
    // Exact pathname match is primary
    if (linkPath === currentPath) {
      // If link includes a hash (fragment-only or same doc anchor), ensure exactness when hash is present
      try {
        var linkUrl = new URL(href, location.href);
        var linkHash = linkUrl.hash || '';
        var currentHash = (new URL(location.href)).hash || '';
        if (linkHash) {
          // Only match if hash matches too
          return linkHash === currentHash;
        }
        return true;
      } catch (e) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a link element active (adds class and aria-current).
   */
  function markLinkActive(linkEl) {
    if (!linkEl) return;
    var c = state.config.classNames.activeLink;
    try {
      if (!linkEl.classList.contains(c)) linkEl.classList.add(c);
    } catch (e) {}
    try {
      linkEl.setAttribute('aria-current', 'page');
    } catch (e) {
      // ignore in old browsers
    }
  }

  /**
   * Unmark a link element active.
   */
  function unmarkLinkActive(linkEl) {
    if (!linkEl) return;
    var c = state.config.classNames.activeLink;
    try {
      if (linkEl.classList.contains(c)) linkEl.classList.remove(c);
    } catch (e) {}
    try {
      linkEl.removeAttribute('aria-current');
    } catch (e) {
      // ignore
    }
  }

  /**
   * Highlight active link(s) in the nav.
   * Accepts optional opts for deferred behavior.
   */
  function highlightActiveLink(opts) {
    opts = opts || {};
    var links = state.elements.links || [];
    // If we don't have links yet but we have a nav, attempt to collect anchors inside it
    if ((!links || !links.length) && state.elements.nav) {
      links = Array.prototype.slice.call(state.elements.nav.querySelectorAll('a[href]') || [], 0);
      state.elements.links = links;
    }
    if (!links || !links.length) return;
    // Clear previous marks
    links.forEach(unmarkLinkActive);
    // Run detection
    var matched = [];
    for (var i = 0; i < links.length; i++) {
      try {
        if (linkMatchesLocation(links[i])) {
          matched.push(links[i]);
        }
      } catch (e) {
        // continue on error
      }
    }
    if (matched.length === 0) {
      // Try a looser match: compare beginning segments
      var currentPath = normalizePath(location.href);
      for (var j = 0; j < links.length; j++) {
        try {
          var lp = normalizePath(links[j].getAttribute('href'));
          if (lp !== '/' && currentPath.indexOf(lp) === 0) {
            matched.push(links[j]);
            break;
          }
        } catch (e2) {}
      }
    }
    // Mark matches
    matched.forEach(markLinkActive);
  }

  /**
   * Update any year placeholders in the page.
   * Targets elements matching [data-year] and #current-year.
   */
  function updateCurrentYear() {
    try {
      var year = String((new Date()).getFullYear());
      var els = safeQueryAll('[data-year], #current-year');
      if (!els || !els.length) return;
      for (var i = 0; i < els.length; i++) {
        try {
          els[i].textContent = year;
        } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * Find the nav panel element within nav (panel is optional).
   */
  function findNavPanel(nav) {
    if (!nav) return null;
    var sel = state.config.selectors.navPanel;
    var panel = null;
    if (sel) panel = safeQuerySelectorWithin(nav, sel);
    // fallback: look for common class names
    if (!panel) panel = nav.querySelector('.nav-panel, .nav__panel, .panel, .menu, .nav-list, ul');
    return panel;
  }

  /**
   * Helper to querySelector within a container safely.
   */
  function safeQuerySelectorWithin(container, selector) {
    try {
      if (!container || !selector || typeof selector !== 'string' || selector.trim() === '') return null;
      return container.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  /**
   * Toggle nav open/closed.
   * If `force` is boolean, sets explicit state. Otherwise toggles.
   */
  function toggleNav(force) {
    var nav = state.elements.nav;
    if (!nav) return;
    var panel = state.elements.panel;
    var toggles = state.elements.toggles || [];
    var openClassPanel = state.config.classNames.panelOpen;
    var openClassNav = state.config.classNames.navOpen;
    var bodyOpenClass = state.config.bodyOpenClass;

    var willOpen = typeof force === 'boolean' ? !!force : !state.isOpen;
    state.isOpen = willOpen;

    // Set data-open on nav to match many CSS patterns
    try {
      nav.setAttribute('data-open', willOpen ? 'true' : 'false');
    } catch (e) {}

    // Apply class to nav as well (some CSS targets nav.is-open)
    try {
      if (willOpen) {
        nav.classList.add(openClassNav);
      } else {
        nav.classList.remove(openClassNav);
      }
    } catch (e) {}

    // Update panel aria-hidden and class if panel exists
    if (panel) {
      try {
        panel.setAttribute('aria-hidden', String(!willOpen));
      } catch (e) {}
      try {
        if (willOpen) {
          panel.classList.add(openClassPanel);
        } else {
          panel.classList.remove(openClassPanel);
        }
      } catch (e) {}
    }

    // Update aria-expanded on toggles
    for (var ti = 0; ti < toggles.length; ti++) {
      try {
        toggles[ti].setAttribute(state.config.ariaExpandedAttr, String(!!willOpen));
      } catch (e) {}
    }

    // Toggle body class if configured
    try {
      if (bodyOpenClass) {
        if (willOpen) document.body.classList.add(bodyOpenClass);
        else document.body.classList.remove(bodyOpenClass);
      }
    } catch (e) {}

    // Manage focus if opening
    if (willOpen && state.config.focusFirstLinkOnOpen) {
      var firstLink = (state.elements.links && state.elements.links[0]) || null;
      if (firstLink && typeof firstLink.focus === 'function') {
        // Delay focus slightly to allow CSS transitions if any
        window.setTimeout(function () {
          try { firstLink.focus(); } catch (e) {}
        }, 50);
      }
    }
  }

  /**
   * Close nav if open.
   */
  function closeNav() {
    if (state.isOpen) toggleNav(false);
  }

  /**
   * Handler: toggle button click/keydown.
   */
  function onToggleClick(e) {
    if (!e) return;
    // If toggle is an anchor, prevent navigation (common pattern for toggles)
    try {
      var el = e.currentTarget || e.target;
      if (el && el.tagName && el.tagName.toLowerCase() === 'a') {
        // Only prevent if it's a fragment or empty href or javascript pseudo-link
        var href = el.getAttribute && el.getAttribute('href');
        if (!href || href.indexOf('#') === 0 || href === '' || href.indexOf('javascript:') === 0) {
          if (e.preventDefault) e.preventDefault();
        }
      }
    } catch (e2) {}
    toggleNav();
  }

  function onToggleKeydown(e) {
    var code = e.key || e.keyCode;
    // Support Enter and Space to act as click for non-button elements
    if (code === 'Enter' || code === 13 || code === ' ' || code === 'Spacebar' || code === 32) {
      // Prevent page scrolling on Space
      if (e.preventDefault) e.preventDefault();
      toggleNav();
    }
  }

  /**
   * Handle Escape to close nav.
   */
  function onDocumentKeydown(e) {
    var code = e.key || e.keyCode;
    if (code === 'Escape' || code === 'Esc' || code === 27) {
      closeNav();
      // Also close demo modal if open
      if (state._demo && state._demo.isOpen) {
        closeDemoModal();
      }
    }
  }

  /**
   * Click outside to close nav.
   */
  function onDocumentClick(e) {
    if (!state.elements.nav) return;
    var nav = state.elements.nav;
    var toggles = state.elements.toggles || [];
    var target = e.target || e.srcElement;
    if (!target) return;
    // If click originates from toggle, let toggle handler handle it.
    for (var i = 0; i < toggles.length; i++) {
      try {
        if (toggles[i] === target || toggles[i].contains(target)) return;
      } catch (ex) {}
    }
    // If click is inside nav, do nothing
    try {
      if (nav.contains(target)) return;
    } catch (e) {
      // if contains fails, skip
    }
    // Otherwise close
    closeNav();
  }

  /**
   * Attach listeners safely, store references for later removal.
   * Stores a boolean capture flag to improve cross-browser compatibility on removal.
   */
  function attachListener(target, type, handler, options) {
    if (!target || !target.addEventListener) return;
    try {
      target.addEventListener(type, handler, options || false);
    } catch (e) {
      // Some older browsers don't accept options objects; fallback to boolean
      try {
        var boolOpt = options && typeof options === 'object' ? !!options.capture : !!options;
        target.addEventListener(type, handler, boolOpt);
      } catch (e2) {
        // give up
        return;
      }
    }
    // Determine capture boolean for removal compatibility
    var capture = false;
    if (typeof options === 'boolean') {
      capture = !!options;
    } else if (options && typeof options === 'object') {
      capture = !!options.capture;
    } else {
      capture = false;
    }
    // Store so we can remove later; store capture boolean only
    state.listeners[type] = state.listeners[type] || [];
    state.listeners[type].push({ target: target, handler: handler, capture: capture });
  }

  /**
   * Remove all attached listeners.
   */
  function removeAllListeners() {
    var map = state.listeners || {};
    Object.keys(map).forEach(function (type) {
      var arr = map[type] || [];
      for (var i = 0; i < arr.length; i++) {
        try {
          var item = arr[i];
          item.target.removeEventListener(type, item.handler, item.capture || false);
        } catch (e) {}
      }
    });
    state.listeners = {};
  }

  /**
   * Initialize: find elements, set ARIA defaults, attach listeners.
   * Options may override selectors and classes.
   */
  function init(options) {
    // Respect an existing initialization marker from other scripts (avoid double-init)
    // But allow re-init when explicit options are provided (fixes earlier short-circuit problem)
    if (typeof window !== 'undefined' && window.__siteNavReady === true && !options) {
      return;
    }

    if (state.initted) {
      // Idempotent: ensure re-configuration if options passed
      if (!options) return;
    }
    state.config = merge(DEFAULTS, options || {});

    // Query DOM via safe helpers with tolerant selectors
    var nav = safeQuerySelector(state.config.selectors.nav);
    var toggles = safeQueryAll(state.config.selectors.navToggle);
    var links = safeQueryAll(state.config.selectors.navLinks);

    // If links not found globally, try to find inside nav
    if ((!links || !links.length) && nav) {
      links = Array.prototype.slice.call(nav.querySelectorAll('a[href]') || [], 0);
    }

    state.elements.nav = nav;
    state.elements.toggles = toggles || [];
    state.elements.links = links || [];
    state.elements.panel = findNavPanel(nav);

    // Store original attribute values so we can restore them on destroy
    state._original = { nav: {}, panel: {}, toggles: [] };

    // ARIA wiring: toggles should aria-controls panel id (preferred) or nav id, but do not overwrite author attributes
    if (nav) {
      ensureId(nav, 'site-nav');
      // store original nav data-open if any
      try { state._original.nav.dataOpen = nav.getAttribute('data-open'); } catch (e) { state._original.nav.dataOpen = null; }
    }
    // store original panel attributes
    if (state.elements.panel) {
      try { state._original.panel.ariaHidden = state.elements.panel.getAttribute('aria-hidden'); } catch (e) { state._original.panel.ariaHidden = null; }
      try { state._original.panel.classListContainsOpen = state.elements.panel.classList ? state.elements.panel.classList.contains(state.config.classNames.panelOpen) : false; } catch (e) { state._original.panel.classListContainsOpen = false; }
      // ensure panel has an id for aria-controls if needed
      try { ensureId(state.elements.panel, (nav && nav.id ? nav.id + '-panel' : 'site-nav-panel')); } catch (e) {}
    }

    toggles.forEach(function (btn) {
      // record original attributes
      var record = { el: btn, attrs: {} };
      try { record.attrs.ariaControls = btn.getAttribute('aria-controls'); } catch (e) { record.attrs.ariaControls = null; }
      try { record.attrs.ariaExpanded = btn.getAttribute(state.config.ariaExpandedAttr); } catch (e) { record.attrs.ariaExpanded = null; }
      try { record.attrs.role = btn.getAttribute('role'); } catch (e) { record.attrs.role = null; }
      try { record.attrs.tabIndex = btn.hasAttribute('tabindex') ? btn.getAttribute('tabindex') : null; } catch (e) { record.attrs.tabIndex = null; }
      state._original.toggles.push(record);

      try {
        // Ensure it's focusable, if not a button
        if ((btn.tabIndex === undefined || btn.tabIndex < 0) && btn.getAttribute) {
          btn.tabIndex = 0;
        }
      } catch (e) {}

      // Only set aria-controls if author did not provide one and we have a panel (prefer panel.id)
      try {
        var existingControls = null;
        try { existingControls = btn.getAttribute('aria-controls'); } catch (er) { existingControls = null; }
        if (!existingControls) {
          if (state.elements.panel && state.elements.panel.id) {
            btn.setAttribute('aria-controls', state.elements.panel.id);
          } else if (nav && nav.id) {
            btn.setAttribute('aria-controls', nav.id);
          }
        } // else preserve author's aria-controls
      } catch (e) {}

      // Set aria-expanded to reflect state
      try {
        btn.setAttribute(state.config.ariaExpandedAttr, String(!!state.isOpen));
      } catch (e) {}

      // Provide role button for non-button elements but avoid overwriting an author-provided role
      try {
        if (btn.tagName && btn.tagName.toLowerCase() !== 'button' && !btn.getAttribute('role')) {
          btn.setAttribute('role', 'button');
        }
      } catch (e) {}
    });

    // Attach event handlers (avoid duplicates by removing any previously attached)
    removeAllListeners();

    // Toggle click/keyboard
    toggles.forEach(function (btn) {
      // Don't use passive on interactive control clicks so we can preventDefault when needed
      attachListener(btn, 'click', onToggleClick, false);
      attachListener(btn, 'keydown', onToggleKeydown, false);
    });

    // Close on escape
    attachListener(document, 'keydown', onDocumentKeydown, false);
    // Click outside to close (passive true is fine)
    attachListener(document, 'click', onDocumentClick, { passive: true });

    // Update any year placeholders
    updateCurrentYear();

    // Highlight active link - defer if possible and record IDs for cleanup
    try {
      // clear any previous deferred ids
      if (state._idleId && typeof cancelIdleCallback === 'function') {
        try { cancelIdleCallback(state._idleId); } catch (e) {}
        state._idleId = null;
      }
      if (state._timeoutId) {
        try { clearTimeout(state._timeoutId); } catch (e) {}
        state._timeoutId = null;
      }

      if (typeof requestIdleCallback === 'function') {
        var idleId = requestIdleCallback(function () { highlightActiveLink(); }, { timeout: state.config.deferDelay });
        // store for cleanup
        state._idleId = idleId;
      } else {
        // store timeout id so it can be cleared on destroy
        state._timeoutId = window.setTimeout(function () {
          // clear stored id once executed
          state._timeoutId = null;
          highlightActiveLink();
        }, state.config.deferDelay);
      }
    } catch (e) {
      // if scheduling fails, run immediately
      highlightActiveLink();
    }

    // Mark initted to prevent duplicate init
    state.initted = true;

    // Handshake marker for other inline scripts
    try {
      if (typeof window !== 'undefined') window.__siteNavReady = true;
    } catch (e) {}
  }

  /**
   * Tear down behavior and restore initial aria/class state.
   */
  function destroy() {
    if (!state.initted) return;

    // Close nav
    closeNav();

    // Close demo modal if open
    if (state._demo && state._demo.isOpen) {
      closeDemoModal(true);
    }

    // Remove classes from links
    if (state.elements.links) {
      state.elements.links.forEach(function (a) {
        unmarkLinkActive(a);
      });
    }

    // Restore toggles attributes from recorded originals
    if (state._original && state._original.toggles) {
      state._original.toggles.forEach(function (rec) {
        var btn = rec.el;
        var attrs = rec.attrs || {};
        try {
          if (attrs.ariaControls === null || attrs.ariaControls === undefined) {
            btn.removeAttribute('aria-controls');
          } else {
            btn.setAttribute('aria-controls', attrs.ariaControls);
          }
        } catch (e) {}
        try {
          if (attrs.ariaExpanded === null || attrs.ariaExpanded === undefined) {
            btn.removeAttribute(state.config.ariaExpandedAttr);
          } else {
            btn.setAttribute(state.config.ariaExpandedAttr, attrs.ariaExpanded);
          }
        } catch (e) {}
        try {
          if (attrs.role === null || attrs.role === undefined) {
            // only remove role if we set it (i.e., was null originally)
            if (btn.getAttribute && btn.getAttribute('role') === 'button' && btn.tagName.toLowerCase() !== 'button') {
              btn.removeAttribute('role');
            }
          } else {
            btn.setAttribute('role', attrs.role);
          }
        } catch (e) {}
        try {
          if (attrs.tabIndex === null || attrs.tabIndex === undefined) {
            // remove if we added it
            if (btn.hasAttribute && btn.hasAttribute('tabindex')) btn.removeAttribute('tabindex');
          } else {
            btn.setAttribute('tabindex', attrs.tabIndex);
          }
        } catch (e) {}
      });
    }

    // Restore nav attributes
    try {
      if (state.elements.nav) {
        var origDataOpen = state._original && state._original.nav ? state._original.nav.dataOpen : null;
        if (origDataOpen === null || origDataOpen === undefined) {
          try { state.elements.nav.removeAttribute('data-open'); } catch (e) {}
        } else {
          try { state.elements.nav.setAttribute('data-open', origDataOpen); } catch (e) {}
        }
        // remove nav-level open class if present
        try { state.elements.nav.classList.remove(state.config.classNames.navOpen); } catch (e) {}
      }
    } catch (e) {}

    // Restore panel attributes and classes
    try {
      var panel = state.elements.panel;
      if (panel && state._original && state._original.panel) {
        var origAria = state._original.panel.ariaHidden;
        if (origAria === null || origAria === undefined) {
          try { panel.removeAttribute('aria-hidden'); } catch (e) {}
        } else {
          try { panel.setAttribute('aria-hidden', origAria); } catch (e) {}
        }
        // Restore panel open class presence based on recorded boolean
        try {
          var hadOpen = !!state._original.panel.classListContainsOpen;
          var panelClass = state.config.classNames.panelOpen;
          if (!hadOpen) {
            panel.classList.remove(panelClass);
          } else {
            panel.classList.add(panelClass);
          }
        } catch (e) {}
      }
    } catch (e) {}

    // Cancel idle callback if pending and clear timeout fallback
    try {
      if (state._idleId && typeof cancelIdleCallback === 'function') {
        try { cancelIdleCallback(state._idleId); } catch (e) {}
      }
    } catch (e) {}
    try {
      if (state._timeoutId) {
        try { clearTimeout(state._timeoutId); } catch (e) {}
      }
    } catch (e) {}
    state._idleId = null;
    state._timeoutId = null;

    // Remove listeners
    removeAllListeners();

    // Remove body open class if set
    try {
      if (state.config && state.config.bodyOpenClass) {
        document.body.classList.remove(state.config.bodyOpenClass);
      }
    } catch (e) {}

    // Reset state
    state.initted = false;
    state.isOpen = false;
    state.elements = { nav: null, panel: null, toggles: [], links: [] };
    state._original = { nav: {}, panel: {}, toggles: [] };

    // Clear initialization handshake flag
    try {
      if (typeof window !== 'undefined') window.__siteNavReady = false;
    } catch (e) {}
  }

  /**
   * Demo modal utilities
   */

  function addDemoListener(target, type, handler, capture) {
    if (!target || !target.addEventListener) return;
    try {
      target.addEventListener(type, handler, !!capture);
      state._demo.listeners.push({ target: target, type: type, handler: handler, capture: !!capture });
    } catch (e) {
      // ignore
    }
  }

  function removeDemoListeners() {
    var arr = state._demo.listeners || [];
    for (var i = 0; i < arr.length; i++) {
      try {
        var it = arr[i];
        it.target.removeEventListener(it.type, it.handler, it.capture || false);
      } catch (e) {}
    }
    state._demo.listeners = [];
  }

  function getFocusableElements(container) {
    if (!container || !container.querySelectorAll) return [];
    var selector = 'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
    try {
      return Array.prototype.slice.call(container.querySelectorAll(selector), 0);
    } catch (e) {
      return [];
    }
  }

  function buildDemoModal(demoId) {
    // Build overlay and dialog structure
    var overlay = document.createElement('div');
    overlay.className = 'demo-modal-overlay';
    overlay.setAttribute('data-demo-modal', demoId || '');
    overlay.style.zIndex = 10000;

    var dialog = document.createElement('div');
    dialog.className = 'demo-modal';
    // ID for labeling
    var titleId = 'demo-modal-title-' + (demoId || Math.random().toString(36).slice(2, 6));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.tabIndex = -1;

    // Visual wrapper
    var content = document.createElement('div');
    content.className = 'demo-modal-content';

    var title = document.createElement('h2');
    title.id = titleId;
    title.className = 'demo-modal-title';
    title.textContent = 'Demo ' + (demoId || '');

    var desc = document.createElement('p');
    desc.className = 'demo-modal-desc';
    desc.textContent = 'This is a placeholder for Demo ' + (demoId || '') + '. Interactive demo content would appear here.';

    var actions = document.createElement('div');
    actions.className = 'demo-modal-actions';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'demo-modal-close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close demo';
    closeBtn.setAttribute('aria-label', 'Close demo dialog');

    actions.appendChild(closeBtn);
    content.appendChild(title);
    content.appendChild(desc);
    content.appendChild(actions);
    dialog.appendChild(content);
    overlay.appendChild(dialog);

    return {
      overlay: overlay,
      dialog: dialog,
      closeBtn: closeBtn,
      title: title,
      desc: desc
    };
  }

  function openDemoModal(demoId, opener) {
    // If modal already open, close first
    if (state._demo && state._demo.isOpen) {
      closeDemoModal();
    }
    // build modal
    var m = buildDemoModal(demoId);
    state._demo.modal = m;
    // Append to body
    try {
      document.body.appendChild(m.overlay);
    } catch (e) {
      // fallback: append to documentElement
      try { document.documentElement.appendChild(m.overlay); } catch (e2) {}
    }
    // Save last active element to restore focus later
    state._demo.lastActive = opener || document.activeElement || null;
    state._demo.isOpen = true;

    // Inert/aria-hide main content for screen readers
    var main = safeQuerySelector('main');
    if (main) {
      try { main.setAttribute('aria-hidden', 'true'); } catch (e) {}
    }

    // Add body class for modal open (styles can use .modal-open)
    try { document.body.classList.add('modal-open'); } catch (e) {}

    // Focus management: focus close button after slight delay
    window.setTimeout(function () {
      try { m.closeBtn.focus(); } catch (e) {}
    }, 10);

    // Attach listeners: close button, overlay click, trap tab, Escape
    var onCloseClick = function (ev) { ev && ev.preventDefault && ev.preventDefault(); closeDemoModal(); };
    var onOverlayClick = function (ev) {
      // close only if click on overlay, not inside dialog
      if (!m.overlay || !m.dialog) return;
      if (ev.target === m.overlay) {
        closeDemoModal();
      }
    };
    var onModalKeydown = function (ev) {
      var code = ev.key || ev.keyCode;
      if (code === 'Escape' || code === 'Esc' || code === 27) {
        ev.preventDefault && ev.preventDefault();
        closeDemoModal();
        return;
      }
      if (code === 'Tab' || code === 9 || code === 'Tab') {
        // trap focus inside modal
        var focusables = getFocusableElements(m.dialog);
        if (!focusables || !focusables.length) {
          // nothing focusable, keep focus on dialog
          ev.preventDefault && ev.preventDefault();
          try { m.dialog.focus(); } catch (e) {}
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        var active = document.activeElement;
        var shift = ev.shiftKey;
        if (shift && active === first) {
          ev.preventDefault && ev.preventDefault();
          try { last.focus(); } catch (e) {}
        } else if (!shift && active === last) {
          ev.preventDefault && ev.preventDefault();
          try { first.focus(); } catch (e) {}
        }
      }
    };

    // Use dedicated demo listener registry so closing modal removes only modal listeners
    addDemoListener(m.closeBtn, 'click', onCloseClick, false);
    addDemoListener(m.overlay, 'click', onOverlayClick, false);
    addDemoListener(document, 'keydown', onModalKeydown, false);

    // Also accessible: announce dialog if needed (title already linked)
    // Log for development/analytics
    try {
      if (window && window.console && window.console.info) {
        window.console.info('Demo modal opened: ' + demoId);
      }
    } catch (e) {}
  }

  function closeDemoModal(forceRemove) {
    if (!state._demo || !state._demo.isOpen) return;
    var m = state._demo.modal || null;
    // Remove aria-hidden from main
    var main = safeQuerySelector('main');
    if (main) {
      try { main.removeAttribute('aria-hidden'); } catch (e) {}
    }
    // Remove body modal class
    try { document.body.classList.remove('modal-open'); } catch (e) {}

    // Remove modal DOM
    try {
      if (m && m.overlay && m.overlay.parentNode) {
        m.overlay.parentNode.removeChild(m.overlay);
      }
    } catch (e) {}

    // Remove modal listeners
    removeDemoListeners();

    // Optionally return focus to opener
    try {
      if (state._demo.lastActive && typeof state._demo.lastActive.focus === 'function') {
        state._demo.lastActive.focus();
      }
    } catch (e) {}

    // Reset demo state
    state._demo.modal = null;
    state._demo.isOpen = false;
    state._demo.lastActive = null;

    if (forceRemove) {
      state._demo.listeners = [];
    }
    try {
      if (window && window.console && window.console.info) {
        window.console.info('Demo modal closed');
      }
    } catch (e) {}
  }

  /**
   * Demo CTA handlers + initializer
   * - Attaches click and keyboard handlers to .demo-cta
   * - Builds and opens accessible modal placeholder for demos
   */
  function onDemoCtaClick(e) {
    if (!e) return;
    var btn = e.currentTarget || e.target;
    if (!btn) return;
    var demoId = btn.getAttribute('data-demo') || (btn.dataset && btn.dataset.demo) || '';
    // Prefer modal for view demos
    try {
      openDemoModal(demoId, btn);
    } catch (err) {
      // Fallback: at least log
      try { console.log('Open demo', demoId); } catch (e2) {}
    }
  }

  function onDemoCtaKeydown(e) {
    var code = e.key || e.keyCode;
    if (code === 'Enter' || code === 13 || code === ' ' || code === 'Spacebar' || code === 32) {
      if (e.preventDefault) e.preventDefault();
      onDemoCtaClick(e);
    }
  }

  function initDemoBlocks() {
    // Defensive: don't run if no DOM
    if (typeof document === 'undefined') return;
    var ctas = safeQueryAll('.demo-cta');
    if (!ctas || !ctas.length) return;
    // Clean up any previous demo listeners if present
    removeDemoListeners();
    // Attach handlers
    for (var i = 0; i < ctas.length; i++) {
      var btn = ctas[i];
      try {
        // ensure it's keyboard accessible
        if (btn.tagName && btn.tagName.toLowerCase() !== 'button') {
          try { if (!btn.hasAttribute('role')) btn.setAttribute('role', 'button'); } catch (e) {}
          try { if (btn.tabIndex === undefined || btn.tabIndex < 0) btn.tabIndex = 0; } catch (e) {}
        }
        // Aria hint
        try { if (!btn.hasAttribute('aria-haspopup')) btn.setAttribute('aria-haspopup', 'dialog'); } catch (e) {}
      } catch (e) {}
      addDemoListener(btn, 'click', onDemoCtaClick, false);
      addDemoListener(btn, 'keydown', onDemoCtaKeydown, false);
    }
  }

  /**
   * Public object returned by the module.
   */
  var api = {
    init: init,
    destroy: destroy,
    toggleNav: toggleNav,
    highlightActiveLink: highlightActiveLink,
    // Demo initializer
    initDemoBlocks: initDemoBlocks,
    // Expose internals for testing/debugging in dev mode only
    _state: state,
    _defaults: DEFAULTS
  };

  // Initialize once on DOMContentLoaded automatically (defensive)
  try {
    // If a prior script has already declared ready, still attempt to run demo init when DOM ready,
    // but avoid re-running nav init unless explicit options are provided.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function onDomLoaded() {
        document.removeEventListener('DOMContentLoaded', onDomLoaded);
        // Intentionally silent if elements missing (graceful degradation)
        try { api.init(); } catch (e) { /* swallow */ }
        try { api.initDemoBlocks(); } catch (e) { /* swallow */ }
      }, { passive: true });
    } else {
      // DOM already ready
      try { api.init(); } catch (e) { /* swallow */ }
      try { api.initDemoBlocks(); } catch (e) { /* swallow */ }
    }
  } catch (e) {
    // If addEventListener or document is not available, no-op
  }

  return api;
}));