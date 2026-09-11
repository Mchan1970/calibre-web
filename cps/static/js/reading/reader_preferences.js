/* exported ReaderPreferences */
// One complete, versioned snapshot per book. Legacy keys are import-only.
var ReaderPreferences = (function () {
    "use strict";
    var defaults = {
        version: 1, font: "default", fontSize: 100, theme: "lightTheme", customTheme: "#ffffff",
        spread: "auto", showPages: true, sidebarReflow: false, forceFont: false,
        lineHeight: null, letterSpacing: null, forceSpacing: false
    };
    var key = "calibre.reader.preferences.v1." + window.calibre.bookUrl;
    var listeners = [];
    var instance = null;
    var storageFailed = false;
    var hasSnapshot = false;
    var memory = {};
    function read(name) {
        try {
            return localStorage.getItem(name);
        } catch (error) {
            storageFailed = true; return null;
        }
    }
    function write(name, value) {
        try {
            localStorage.setItem(name, value); return true;
        } catch (error) {
            storageFailed = true; return false;
        }
    }
    function parse(raw) {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }
    function choice(value, values, fallback) {
        return values.indexOf(value) === -1 ? fallback : value;
    }
    function stepped(value, min, max, unit, step, fallback) {
        if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
        var scaled = value * unit;
        var rounded = Math.round(scaled);
        return value >= min && value <= max && Math.abs(scaled - rounded) < 0.000001 &&
            rounded % step === 0 ? rounded / unit : fallback;
    }
    function normalize(value) {
        value = value || {};
        var result = Object.assign({}, defaults);
        result.font = choice(value.font, ["default", "Yahei", "SimSun", "KaiTi", "Arial"], defaults.font);
        result.theme = choice(value.theme, ["lightTheme", "darkTheme", "sepiaTheme", "amberTheme", "blackTheme", "customTheme"], defaults.theme);
        result.spread = choice(value.spread, ["auto", "none"], defaults.spread);
        result.customTheme = typeof value.customTheme === "string" && /^#[0-9a-f]{6}$/i.test(value.customTheme)
            ? value.customTheme : defaults.customTheme;
        result.fontSize = stepped(value.fontSize, 50, 300, 1, 5, defaults.fontSize);
        result.lineHeight = stepped(value.lineHeight, 1.2, 2.2, 10, 1, null);
        result.letterSpacing = stepped(value.letterSpacing, 0, 0.2, 100, 2, null);
        ["showPages", "sidebarReflow", "forceFont", "forceSpacing"].forEach(function (field) {
            if (typeof value[field] === "boolean") result[field] = value[field];
        });
        return result;
    }
    var raw = read(key);
    var oldFontSize = read("calibre.reader.fontSize");
    var state;
    if (raw !== null) {
        hasSnapshot = true;
        var saved = parse(raw);
        state = normalize(saved && saved.version === 1 ? saved : defaults);
    } else {
        var spacing = parse(read("calibre.reader.spacing.v1." + window.calibre.bookUrl));
        var pages = read("calibre.reader.showPages");
        state = normalize({
            font: read("calibre.reader.font"), fontSize: oldFontSize === null ? 100 : Number(oldFontSize),
            theme: read("calibre.reader.theme"), customTheme: read("calibre.reader.customTheme"),
            showPages: pages === null ? true : pages === "true",
            forceFont: read("calibre.reader.forceFont." + window.calibre.bookUrl) === "true",
            lineHeight: spacing && spacing.version === 1 ? spacing.lineHeight : null,
            letterSpacing: spacing && spacing.version === 1 ? spacing.letterSpacing : null,
            forceSpacing: !!(spacing && spacing.version === 1 && spacing.force === true)
        });
    }
    function get() {
        return Object.assign({}, state);
    }
    function syncVendor(persist) {
        if (!instance) return;
        instance.settings.sidebarReflow = state.sidebarReflow;
        instance.settings.styles = Object.assign({}, instance.settings.styles, {fontSize: state.fontSize + "%"});
        if (!persist || !instance.settings.bookKey) return;
        // Preserve bookmarks, annotations, reading position and unknown fields.
        var stored = parse(read(instance.settings.bookKey));
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
        stored.sidebarReflow = state.sidebarReflow;
        stored.styles = Object.assign({}, stored.styles, {fontSize: state.fontSize + "%"});
        write(instance.settings.bookKey, JSON.stringify(stored));
    }
    function notify() {
        listeners.forEach(function (listener) {
            listener(get());
        });
    }
    function set(patch) {
        state = normalize(Object.assign({}, state, patch));
        hasSnapshot = true;
        storageFailed = !write(key, JSON.stringify(state));
        syncVendor(true);
        notify();
    }
    function attach(reader) {
        instance = reader;
        if (!hasSnapshot) {
            state.sidebarReflow = reader.settings.sidebarReflow === true;
            if (oldFontSize === null && reader.settings.styles) {
                state.fontSize = stepped(parseFloat(reader.settings.styles.fontSize), 50, 300, 1, 5, 100);
            }
        }
        syncVendor(false);
        // The vendor's existing beforeunload listener calls this method dynamically.
        // Do not let unavailable currentLocation() discard saved settings or throw.
        reader.saveSettings = function () {
            syncVendor(false);
            var location = reader.rendition && reader.rendition.location;
            if (location && location.start && location.start.cfi) reader.settings.previousLocationCfi = location.start.cfi;
            if (!reader.settings.bookKey) return false;
            var stored = parse(read(reader.settings.bookKey));
            var combined = Object.assign({}, stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}, reader.settings);
            return write(reader.settings.bookKey, JSON.stringify(combined));
        };
    }
    return {
        get: get, set: set, reset: function () {
            set(defaults);
        }, attach: attach,
        subscribe: function (listener) {
            listeners.push(listener);
        },
        failed: function () {
            return storageFailed;
        },
        // Reading positions/EPUB locations are not preferences and retain their keys.
        storage: {
            getItem: function (name) {
                return Object.prototype.hasOwnProperty.call(memory, name) ? memory[name] : read(name);
            },
            setItem: function (name, value) {
                memory[name] = String(value); write(name, String(value));
            }
        }
    };
})();
