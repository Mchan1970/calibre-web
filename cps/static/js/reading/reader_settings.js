/* global $, reader, Pickr */

// Behavior for the EPUB reader's "Settings" modal (#settings-modal): theme
// selection, custom color picker, font size, font family, spread/layout,
// the pages-count toggle, and Escape/focus handling for the modal itself.
//
// window.calibre and window.themes are defined by an inline <script> in
// read.html (they need Jinja-templated url_for()/csrf values); everything
// here is pure behavior and reads those globals at call time.

function selectTheme(id) {
    var themesContainer = document.getElementById("themes");
    var buttons = themesContainer.querySelectorAll("button[aria-pressed]");
    buttons.forEach(function (btn) {
        btn.setAttribute("aria-pressed", "false");
    });

    // Scoped to .tick (not "span") because #customThemeWrapper is itself a
    // <span> containing #customThemeSwatch - a bare "span" selector would
    // also match it and wipe out the swatch via textContent = "".
    var tickSpans = themesContainer.querySelectorAll(".tick");
    tickSpans.forEach(function (tickSpan) {
        try {
            tickSpan.textContent = "";
        } catch (e) {}
    });

    // If the theme button exists, set its inner span to a tick. Otherwise set any span with the matching id.
    var el = document.getElementById(id);
    if (el) {
        el.setAttribute("aria-pressed", "true");
        var sp = el.querySelector("span");
        if (sp) sp.textContent = "✓";
    } else {
        var spById = document.getElementById(id + "Selected") || document.getElementById("customSelected");
        if (spById) spById.textContent = "✓";
    }

    // Saving theme to local storage
    localStorage.setItem("calibre.reader.theme", id);

    var themeConfig = window.themes && window.themes[id];
    if (!themeConfig) {
        // Unknown/stale theme id (e.g. leftover localStorage value) - nothing more we can apply safely.
        return;
    }

    // If selecting custom theme, ensure epubjs theme is registered with chosen bg color
    if (id === "customTheme") {
        var customColor = themeConfig.bgColor || "#ffffff";
        try {
            if (reader && reader.rendition && reader.rendition.themes) {
                reader.rendition.themes.register("customTheme", {
                    body: {
                        background: customColor,
                    },
                });
                reader.rendition.themes.select("customTheme");
            }
        } catch (e) {
            console.error("Failed to register/select customTheme", e);
        }
    } else {
        // Apply theme to epubjs iframe
        try {
            reader.rendition.themes.select(id);
        } catch (e) {}
    }

    // Apply theme to rest of the page.
    document.getElementById("main").style.backgroundColor = themeConfig.bgColor;
    document.getElementById("titlebar").style.color = themeConfig["title-color"] || "#fff";
    document.getElementById("progress").style.color = themeConfig["title-color"] || "#fff";
}

// font size settings logic
var currentFontSize = 100; // default 100%
var minFontSize = 50;
var maxFontSize = 300;
var stepSize = 5;

var fontSizeDisplay = document.getElementById("fontSizeDisplay");
var fontSizeDecrease = document.getElementById("fontSizeDecrease");
var fontSizeIncrease = document.getElementById("fontSizeIncrease");

function updateFontSizeButtonsState() {
    fontSizeDecrease.disabled = currentFontSize <= minFontSize;
    fontSizeIncrease.disabled = currentFontSize >= maxFontSize;
}

function updateFontSize(newSize) {
    if (newSize < minFontSize) newSize = minFontSize;
    if (newSize > maxFontSize) newSize = maxFontSize;

    currentFontSize = newSize;
    fontSizeDisplay.textContent = newSize + "%";
    localStorage.setItem("calibre.reader.fontSize", newSize);
    if (reader && reader.rendition) {
        reader.rendition.themes.fontSize(`${newSize}%`);
    }
    updateFontSizeButtonsState();
}

// Restore saved font size on load
var savedFontSize = localStorage.getItem("calibre.reader.fontSize");
if (savedFontSize) {
    currentFontSize = parseInt(savedFontSize, 10);
    fontSizeDisplay.textContent = savedFontSize + "%";
}
updateFontSizeButtonsState();

fontSizeDecrease.addEventListener("click", function () {
    updateFontSize(currentFontSize - stepSize);
});

fontSizeIncrease.addEventListener("click", function () {
    updateFontSize(currentFontSize + stepSize);
});

// Keep stored button IDs stable, but use real font families on each platform.
var READER_FONTS = {
    Yahei: "\"Microsoft YaHei\", \"PingFang SC\", \"Noto Sans CJK SC\", sans-serif",
    SimSun: "\"SimSun\", \"Songti SC\", \"Noto Serif CJK SC\", serif",
    KaiTi: "\"KaiTi\", \"Kaiti SC\", \"STKaiti\", cursive",
    Arial: "Arial, sans-serif"
};
var PROTECTED_FONT_SELECTOR = "pre, code, kbd, samp, tt, math, svg";
// Weak keys allow discarded chapter documents to be collected.
var originalChapterFonts = new WeakMap();
var forceFontCheckbox = document.getElementById("forceFontOverride");
var forceFontHookRegistered = false;
var currentForceFontValue = null; // the active font-family list, or null

function forceFontStorageKey() {
    return "calibre.reader.forceFont." + (window.calibre && window.calibre.bookUrl ? window.calibre.bookUrl : "");
}

function isForceFontEnabled() {
    return localStorage.getItem(forceFontStorageKey()) === "true";
}

function applyForceFontToContents(contents, fontValue, force) {
    var doc = contents.document;
    var previous = originalChapterFonts.get(doc);
    if (previous) {
        previous.forEach(function (entry) {
            if (entry.value) {
                entry.element.style.setProperty("font-family", entry.value, entry.priority);
            } else {
                entry.element.style.removeProperty("font-family");
            }
        });
        originalChapterFonts.delete(doc);
    }
    if (!fontValue || !doc.body) return;

    var entries = [];
    var protectedFonts = [];
    var elements = force
        ? [doc.body].concat(Array.from(doc.body.querySelectorAll("*"))) : [doc.body];
    // Capture inherited fonts before changing any ancestor. Protect descendants too.
    elements.forEach(function (element) {
        entries.push({
            element: element,
            value: element.style.getPropertyValue("font-family"),
            priority: element.style.getPropertyPriority("font-family")
        });
        protectedFonts.push(force && element.closest(PROTECTED_FONT_SELECTOR)
            ? doc.defaultView.getComputedStyle(element).fontFamily : null);
    });
    originalChapterFonts.set(doc, entries);
    elements.forEach(function (element, index) {
        element.style.setProperty("font-family", protectedFonts[index] || fontValue, "important");
    });
}

// Own the reversible font override in both modes. Removing an epub.js body
// override would also remove a font-family originally supplied inline by the book.
function updateReaderFont() {
    if (!reader || !reader.rendition) return;
    ensureForceFontHook();
    applyForceFontToAllCurrentContents(currentForceFontValue);
}

function applyForceFontToAllCurrentContents(fontValue) {
    if (!reader || !reader.rendition) return;
    reader.rendition.getContents().forEach(function (contents) {
        applyForceFontToContents(contents, fontValue, isForceFontEnabled());
    });
}

function ensureForceFontHook() {
    if (forceFontHookRegistered) return;
    if (!reader || !reader.rendition || !reader.rendition.hooks || !reader.rendition.hooks.content) return;
    // Re-applies the current override to every newly rendered chapter
    // (page turns load a fresh iframe), the same hook epub.js's own Themes
    // implementation uses to persist registered themes/overrides.
    reader.rendition.hooks.content.register(function (contents) {
        if (currentForceFontValue) {
            applyForceFontToContents(contents, currentForceFontValue, isForceFontEnabled());
        }
    });
    forceFontHookRegistered = true;
}

function setForceFontControlState(disabled, checked) {
    if (!forceFontCheckbox) return;
    forceFontCheckbox.disabled = disabled;
    forceFontCheckbox.checked = checked;
}

// Until a non-"default" font is actually selected (below), there is nothing
// to force - keep the control off and unavailable.
setForceFontControlState(true, false);

if (forceFontCheckbox) {
    forceFontCheckbox.addEventListener("change", function () {
        localStorage.setItem(forceFontStorageKey(), String(forceFontCheckbox.checked));
        updateReaderFont();
    });
}

window.selectFont = function (id) {
    if (id !== "default" && !Object.prototype.hasOwnProperty.call(READER_FONTS, id)) {
        id = "default";
    }

    var fontContainer = document.getElementById("font");
    var buttons = fontContainer.querySelectorAll("button[aria-pressed]");
    buttons.forEach(function (btn) {
        btn.setAttribute("aria-pressed", "false");
    });

    var spans = fontContainer.querySelectorAll(".tick");
    for (var i = 0; i < spans.length; i++) {
        spans[i].textContent = "";
    }
    var target = document.getElementById(id);
    target.setAttribute("aria-pressed", "true");
    target.querySelector("span").textContent = "✓";

    // Save font selection to localStorage
    localStorage.setItem("calibre.reader.font", id);

    currentForceFontValue = id === "default" ? null : READER_FONTS[id];
    setForceFontControlState(id === "default", id !== "default" && isForceFontEnabled());
    updateReaderFont();
};

function spread(id) {
    var layoutContainer = document.getElementById("layout");
    var buttons = layoutContainer.querySelectorAll("button[aria-pressed]");
    buttons.forEach(function (btn) {
        btn.setAttribute("aria-pressed", "false");
    });

    var spans = layoutContainer.querySelectorAll(".tick");
    for (var i = 0; i < spans.length; i++) {
        spans[i].textContent = "";
    }
    var target = document.getElementById(id);
    target.setAttribute("aria-pressed", "true");
    target.querySelector("span").textContent = "✓";

    reader.rendition.spread(id === "spread" ? true : "none");
}

// Pages counter visibility setting
(function () {
    var checkbox = document.getElementById("showPagesCount");
    var pagesEl = document.getElementById("pages-count");
    var key = "calibre.reader.showPages";
    var saved = localStorage.getItem(key);
    var show = saved === null ? true : saved === "true";
    if (checkbox) checkbox.checked = show;
    if (pagesEl) pagesEl.style.display = show ? "" : "none";
    if (checkbox) {
        checkbox.addEventListener("change", function () {
            var val = checkbox.checked;
            localStorage.setItem(key, String(val));
            var target = document.getElementById("pages-count");
            if (target) target.style.visibility = val ? "visible" : "hidden";
        });
    }
})();

// Custom theme color picker (Pickr)
(function () {
    var swatch = document.getElementById("customThemeSwatch");
    var saved =
        window.themes && window.themes.customTheme && window.themes.customTheme.bgColor
            ? window.themes.customTheme.bgColor
            : "#ffffff";
    if (swatch) swatch.style.background = saved;

    function _hexToRgb(hex) {
        hex = hex.replace("#", "");
        if (hex.length === 3) {
            hex = hex
                .split("")
                .map(function (h) {
                    return h + h;
                })
                .join("");
        }
        var bigint = parseInt(hex, 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255,
        };
    }

    // Better contrast decision using WCAG relative luminance and contrast ratio
    // Returns true if black text is the better choice (i.e. background is light)
    function _isLight(hex) {
        try {
            var rgb = _hexToRgb(hex);
            var srgb = { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 };
            function lin(c) {
                return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            }
            var R = lin(srgb.r),
                G = lin(srgb.g),
                B = lin(srgb.b);
            var L = 0.2126 * R + 0.7152 * G + 0.0722 * B; // relative luminance

            var contrastWithBlack = (L + 0.05) / (0.0 + 0.05);
            var contrastWithWhite = (1.0 + 0.05) / (L + 0.05);

            return contrastWithBlack >= contrastWithWhite;
        } catch (e) {
            return true;
        }
    }

    function applyCustomColor(hex) {
        if (!hex) return;
        if (hex[0] !== "#") hex = "#" + hex;
        window.themes.customTheme.bgColor = hex;
        try {
            localStorage.setItem("calibre.reader.customTheme", hex);
        } catch (e) {}
        if (swatch) swatch.style.background = hex;

        try {
            localStorage.setItem("calibre.reader.theme", "customTheme");
        } catch (e) {}

        var tickSpans = document.getElementById("themes").querySelectorAll(".tick");
        tickSpans.forEach(function (ts) {
            ts.textContent = "";
        });
        var themeButtons = document.getElementById("themes").querySelectorAll("button[aria-pressed]");
        themeButtons.forEach(function (btn) {
            btn.setAttribute("aria-pressed", "false");
        });
        var customTick = document.getElementById("customSelected");
        if (customTick) customTick.textContent = "✓";

        var titleColor = _isLight(hex) ? "#000000" : "#ffffff";
        try {
            document.getElementById("main").style.backgroundColor = hex;
            document.getElementById("titlebar").style.color = titleColor;
            document.getElementById("progress").style.color = titleColor;
        } catch (e) {}

        try {
            window.themes.customTheme["title-color"] = titleColor;
        } catch (e) {}

        try {
            if (reader && reader.rendition && reader.rendition.themes) {
                reader.rendition.themes.register("customTheme", {
                    body: { background: hex, color: titleColor },
                });
                reader.rendition.themes.select("customTheme");
            }
        } catch (e) {
            console.error("Failed to apply custom theme to reader", e);
        }
    }

    // Delay init until Pickr is available
    function ensurePickrAndInit() {
        if (window.Pickr) {
            try {
                var pickr = Pickr.create({
                    el: "#customThemeSwatch",
                    useAsButton: true,
                    theme: "classic",
                    default: saved,
                    components: {
                        preview: true,
                        opacity: false,
                        hue: true,
                        interaction: {
                            hex: true,
                            input: true,
                            save: true,
                        },
                    },
                });

                pickr.on("change", function (color) {
                    try {
                        var hex = color.toHEXA().toString();
                        if (swatch) swatch.style.background = hex;
                        applyCustomColor(hex);
                    } catch (e) {}
                });

                pickr.on("save", function (color) {
                    try {
                        var hex = color.toHEXA().toString();
                        if (swatch) swatch.style.background = hex;
                        applyCustomColor(hex);
                        pickr.hide();
                    } catch (e) {}
                });

                if (swatch) {
                    swatch.addEventListener("click", function () {
                        pickr.show();
                    });
                    // The swatch is a role="button" span, not a native button/link,
                    // so it needs an explicit keyboard activation handler.
                    swatch.addEventListener("keydown", function (e) {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            pickr.show();
                        }
                    });
                }
            } catch (e) {
                console.error("Pickr init failed", e);
            }
            return;
        }
        setTimeout(ensurePickrAndInit, 150);
    }

    ensurePickrAndInit();
})();

// Settings modal: Escape-to-close and focus management.
//
// The modal's open/close mechanism itself lives in the third-party
// reader.min.js bundle (click #setting -> add "md-show"; click .closer or
// .overlay -> remove "md-show"). Rather than touching that vendor file, we
// observe the "md-show" class - the single contract every close path already
// converges on - and layer Escape-to-close plus focus handling on top of it.
(function () {
    var modal = document.getElementById("settings-modal");
    var trigger = document.getElementById("setting");
    if (!modal || !trigger) return;

    function isOpen() {
        return modal.classList.contains("md-show");
    }

    function closeModal() {
        modal.classList.remove("md-show");
    }

    var wasOpen = isOpen();
    var observer = new MutationObserver(function () {
        var open = isOpen();
        if (open && !wasOpen) {
            modal.focus();
        } else if (!open && wasOpen) {
            trigger.focus();
        }
        wasOpen = open;
    });
    observer.observe(modal, { attributes: true, attributeFilter: ["class"] });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && isOpen()) {
            closeModal();
        }
    });

    // #setting and .closer are non-native, non-link/button elements
    // (role="button"/tabindex="0" in the markup), so they need explicit
    // keyboard activation handlers to be operable without a mouse.
    trigger.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            trigger.click();
        }
    });

    var closer = modal.querySelector(".closer");
    if (closer) {
        closer.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                closeModal();
            }
        });
    }
})();
