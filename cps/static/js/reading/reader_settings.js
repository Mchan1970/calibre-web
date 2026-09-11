/* global reader, Pickr, ReaderPreferences */
/* exported selectTheme, selectFont, spread, ReaderSettings */

function selectTheme(id) {
    ReaderPreferences.set({theme: id});
}
function selectFont(id) {
    ReaderPreferences.set({font: id});
}
function spread(id) {
    ReaderPreferences.set({spread: id === "spread" ? "auto" : "none"});
}

var ReaderSettings = (function () {
    "use strict";
    var modal = document.getElementById("settings-modal");
    var trigger = document.getElementById("setting");
    var picker = null;
    var syncingPicker = false;
    var last = null;
    var attached = false;
    var tabs = Array.from(modal.querySelectorAll("[role='tab']"));
    var disclosures = document.getElementById("typographyOverrides");
    function open() {
        return modal.classList.contains("md-show");
    }
    function chooseTab(tab, focus) {
        tabs.forEach(function (item) {
            var selected = item === tab;
            item.setAttribute("aria-selected", String(selected));
            item.tabIndex = selected ? 0 : -1;
            document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
        });
        if (focus) tab.focus();
    }
    tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
            chooseTab(tab, false);
        });
    });
    function close() {
        modal.classList.remove("md-show");
    }
    // Capture before the vendor's document bubble listener, which ignores
    // defaultPrevented. Native editing keys retain their default behavior.
    function guardKeys(event) {
        if (!open()) return;
        if (event.key === "Escape") {
            event.preventDefault(); event.stopImmediatePropagation(); close(); return;
        }
        if (event.key === "Tab") {
            var focusable = Array.from(modal.querySelectorAll("button, input, summary, [tabindex='0']"))
                .filter(function (element) {
                    return !element.disabled && element.getClientRects().length;
                });
            var first = focusable[0], end = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
                event.preventDefault(); end.focus();
            } else if (!event.shiftKey && (document.activeElement === end || !modal.contains(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        }
        var keys = ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
        if (keys.indexOf(event.key) === -1) return;
        event.stopImmediatePropagation();
        var index = tabs.indexOf(event.target);
        if (index !== -1 && ["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) !== -1) {
            event.preventDefault();
            var next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
                (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            chooseTab(tabs[next], true);
        }
    }
    document.addEventListener("keydown", guardKeys, true);
    var wasOpen = open();
    new MutationObserver(function () {
        var visible = open();
        if (visible && !wasOpen) {
            disclosures.open = false; chooseTab(tabs[0], true);
        }
        if (!visible && wasOpen) {
            if (picker) picker.hide(); trigger.focus();
        }
        wasOpen = visible;
    }).observe(modal, {attributes: true, attributeFilter: ["class"]});
    modal.querySelector(".closer").addEventListener("click", close);
    trigger.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); trigger.click();
        }
    });

    function mark(container, id) {
        document.getElementById(container).querySelectorAll("button[aria-pressed]").forEach(function (button) {
            var selected = button.id === id;
            button.setAttribute("aria-pressed", String(selected));
            var tick = button.querySelector(".tick");
            if (tick) tick.textContent = selected ? "✓" : "";
        });
    }
    function contrast(hex) {
        var rgb = [1, 3, 5].map(function (offset) {
            var c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        var luminance = (0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2]);
        return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
    }
    // Built-in themes store title-color as short hex ("#fff"); contrast()
    // returns long hex ("#ffffff") for custom colors - match both forms so a
    // dark custom background isn't misread as a light one.
    function schemeFor(state) {
        var titleColor = state.theme === "customTheme"
            ? contrast(state.customTheme)
            : (window.themes[state.theme] || window.themes.lightTheme)["title-color"];
        return /^#(fff|ffffff)$/i.test(titleColor) ? "dark" : "light";
    }
    function applyTheme(state) {
        var config = window.themes[state.theme];
        if (state.theme === "customTheme") {
            config.bgColor = state.customTheme;
            config["title-color"] = contrast(state.customTheme);
            reader.rendition.themes.register("customTheme", {body: {background: config.bgColor, color: config["title-color"]}});
        }
        reader.rendition.themes.select(state.theme);
        document.getElementById("main").style.backgroundColor = config.bgColor;
        document.getElementById("titlebar").style.color = config["title-color"];
        document.getElementById("progress").style.color = config["title-color"];
    }
    function applySidebar(state) {
        reader.settings.sidebarReflow = state.sidebarReflow;
        // Keep the currently open sidebar's geometry in sync with the preference.
        var main = document.getElementById("main");
        main.classList.toggle("single", !!reader.sidebarOpen && state.sidebarReflow);
        main.classList.toggle("closed", !!reader.sidebarOpen && !state.sidebarReflow);
        if (reader.rendition.location) reader.rendition.resize();
    }
    function render(state) {
        modal.dataset.scheme = schemeFor(state);
        document.getElementById("readerSettingsStatus").textContent = "";
        mark("font", state.font);
        mark("themes", state.theme);
        mark("layout", state.spread === "none" ? "nonespread" : "spread");
        document.getElementById("customSelected").textContent = state.theme === "customTheme" ? "✓" : "";
        document.getElementById("fontSizeDisplay").textContent = state.fontSize + "%";
        document.getElementById("fontSizeDecrease").disabled = state.fontSize <= 50;
        document.getElementById("fontSizeIncrease").disabled = state.fontSize >= 300;
        document.getElementById("forceFontOverride").disabled = state.font === "default";
        document.getElementById("forceFontOverride").checked = state.font !== "default" && state.forceFont;
        document.getElementById("showPagesCount").checked = state.showPages;
        document.getElementById("pages-count").style.display = state.showPages ? "" : "none";
        document.getElementById("sidebarReflow").checked = state.sidebarReflow;
        document.getElementById("customThemeSwatch").style.backgroundColor = state.customTheme;
        document.getElementById("readerStorageStatus").hidden = !ReaderPreferences.failed();
        if (picker && (!last || last.customTheme !== state.customTheme)) {
            syncingPicker = true;
            picker.setColor(state.customTheme, true);
            syncingPicker = false;
        }
        if (!attached) return;
        if (!last || state.theme !== last.theme || state.customTheme !== last.customTheme) applyTheme(state);
        if (!last || state.fontSize !== last.fontSize) reader.rendition.themes.fontSize(state.fontSize + "%");
        if (!last || state.spread !== last.spread) reader.rendition.spread(state.spread);
        if (!last || state.sidebarReflow !== last.sidebarReflow) applySidebar(state);
        last = state;
        badge();
    }
    function badge() {
        document.getElementById("overridesActive").hidden = !document.getElementById("forceFontOverride").checked &&
            !document.getElementById("forceSpacingOverride").checked;
    }
    document.addEventListener("reader-spacing-state", badge);
    [["fontSizeDecrease", -5], ["fontSizeIncrease", 5]].forEach(function (pair) {
        document.getElementById(pair[0]).addEventListener("click", function () {
            ReaderPreferences.set({fontSize: Math.max(50, Math.min(300, ReaderPreferences.get().fontSize + pair[1]))});
        });
    });
    document.getElementById("forceFontOverride").addEventListener("change", function (event) {
        ReaderPreferences.set({forceFont: event.target.checked});
    });
    document.getElementById("showPagesCount").addEventListener("change", function (event) {
        ReaderPreferences.set({showPages: event.target.checked});
    });
    // The vendor binds a click toggler later. Capture prevents a double toggle.
    document.getElementById("sidebarReflow").addEventListener("click", function (event) {
        event.stopImmediatePropagation();
        ReaderPreferences.set({sidebarReflow: event.target.checked});
    }, true);
    document.getElementById("resetBookSettings").addEventListener("click", function () {
        ReaderPreferences.reset();
        document.getElementById("readerSettingsStatus").textContent = modal.dataset.resetDone;
    });
    if (window.Pickr) {
        picker = Pickr.create({el: "#customThemeSwatch", useAsButton: true, theme: "classic",
            default: ReaderPreferences.get().customTheme,
            components: {preview: true, opacity: false, hue: true, interaction: {hex: true, input: true, save: true}}});
        function colorChanged(color) {
            if (!syncingPicker && color) ReaderPreferences.set({customTheme: color.toHEXA().toString(), theme: "customTheme"});
        }
        picker.on("change", colorChanged);
        picker.on("save", function (color) {
            colorChanged(color); picker.hide();
        });
        document.getElementById("customThemeSwatch").addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault(); picker.show();
            }
        });
    }
    ReaderPreferences.subscribe(render);
    render(ReaderPreferences.get());
    return {attach: function () {
        attached = true;
        // A chapter has its own document; capture guards its keys before epub.js
        // forwards them to the vendor's rendition arrow handler.
        reader.rendition.hooks.content.register(function (contents) {
            contents.document.addEventListener("keydown", guardKeys, true);
        });
        render(ReaderPreferences.get());
    }};
})();
