/* global reader, ReaderPreferences */
/* exported ReaderSpacing */

// Shared, reversible typography overrides for chapter documents.
var ReaderSpacing = (function () {
    "use strict";
    var originals = new WeakMap();
    var initialized = false;
    var settleFrame = null;
    var anchor = null;
    var updateGeneration = 0;
    var layoutState = "pending";
    var protectedSelector = "pre, code, kbd, samp, tt, math, svg";
    var specs = {
        lineHeight: {property: "line-height", min: 12, max: 22, unit: 10, step: 1, initial: 16},
        letterSpacing: {property: "letter-spacing", min: 0, max: 20, unit: 100, step: 2, initial: 2}
    };
    var state = {version: 1, lineHeight: null, letterSpacing: null, force: false};
    var root = document.getElementById("spacing");
    var forceControl = document.getElementById("forceSpacingOverride");
    var status = document.getElementById("spacingStatus");

    var fonts = {
        Yahei: "\"Microsoft YaHei\", \"PingFang SC\", \"Noto Sans CJK SC\", sans-serif",
        SimSun: "\"SimSun\", \"Songti SC\", \"Noto Serif CJK SC\", serif",
        KaiTi: "\"KaiTi\", \"Kaiti SC\", \"STKaiti\", cursive",
        Arial: "Arial, sans-serif"
    };
    function readState() {
        var prefs = ReaderPreferences.get();
        state.lineHeight = prefs.lineHeight;
        state.letterSpacing = prefs.letterSpacing;
        state.force = prefs.forceSpacing;
    }

    function bookLayout() {
        if (!reader || !reader.rendition) return "pending";
        // layout() is not a read-only getter in this epub.js bundle: it calls
        // manager.applyLayout(), which can emit another layout event. Reading
        // it from our layout listener re-enters layout during startup.
        var manager = reader.rendition.manager;
        var layout = manager && manager.layout;
        if (!layout || !layout.name || !reader.book.spine) return "pending";
        var sections = reader.book.spine.spineItems || [];
        // This bundled engine does not call Section.reconcileLayoutSettings.
        // Never apply spacing when a spine override requests fixed layout,
        // even if the global rendition still reports reflowable.
        if (layout.name === "pre-paginated" || sections.some(function (section) {
            return (section.properties || []).indexOf("rendition:layout-pre-paginated") !== -1;
        })) return "fixed";
        return layout.name === "reflowable" ? "reflowable" : "pending";
    }

    function eligible(contents) {
        if (bookLayout() !== "reflowable") return false;
        var section = reader.book.spine.get(contents.sectionIndex);
        return !!section && (section.properties || []).indexOf("rendition:layout-pre-paginated") === -1;
    }

    function updateControls() {
        readState();
        layoutState = bookLayout();
        var disabled = layoutState !== "reflowable";
        Object.keys(specs).forEach(function (key) {
            var value = state[key];
            var spec = specs[key];
            document.getElementById(key + "Display").textContent = value === null
                ? root.dataset.original : value.toFixed(key === "lineHeight" ? 1 : 2) + (key === "letterSpacing" ? " em" : "×");
            document.getElementById(key + "Decrease").disabled = disabled || (value !== null && value * spec.unit <= spec.min);
            document.getElementById(key + "Increase").disabled = disabled || (value !== null && value * spec.unit >= spec.max);
            document.getElementById(key + "Reset").disabled = disabled || value === null;
        });
        var original = state.lineHeight === null && state.letterSpacing === null;
        forceControl.disabled = disabled || original;
        forceControl.checked = !disabled && !original && state.force;
        status.textContent = root.dataset[layoutState];
        document.dispatchEvent(new Event("reader-spacing-state"));
    }

    function restore(doc) {
        var old = originals.get(doc);
        if (!old) return;
        old.entries.forEach(function (entry) {
            if (entry.value) entry.element.style.setProperty(entry.property, entry.value, entry.priority);
            else entry.element.style.removeProperty(entry.property);
        });
        originals.delete(doc);
    }

    function isProtected(element, property) {
        if (element.closest(protectedSelector)) return true;
        if (property !== "line-height") return false;
        for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
            if (node.matches("sup, sub")) return true;
            var type = node.getAttributeNS("http://www.idpf.org/2007/ops", "type") || node.getAttribute("epub:type") || "";
            if (type.split(/\s+/).indexOf("noteref") !== -1) return true;
        }
        return false;
    }

    function apply(contents) {
        var doc = contents.document;
        if (!doc || !doc.body) return;
        readState();
        var prefs = ReaderPreferences.get();
        var rules = [];
        if (prefs.font !== "default") {
            rules.push({property: "font-family", value: fonts[prefs.font], force: prefs.forceFont});
        }
        if (eligible(contents)) {
            Object.keys(specs).forEach(function (key) {
                if (state[key] !== null) {
                    rules.push({property: specs[key].property,
                        value: String(state[key]) + (key === "letterSpacing" ? "em" : ""), force: state.force});
                }
            });
        }
        var signature = JSON.stringify([rules, prefs.fontSize]);
        var old = originals.get(doc);
        if (old && old.signature === signature) return;
        restore(doc);
        if (!rules.length) return;
        var entries = [];
        var writes = [];
        var elements = [doc.body].concat(Array.from(doc.body.querySelectorAll("*")));
        // Restore all managed attributes first, read all protected values next,
        // then write. Longhands preserve unrelated font shorthand components.
        elements.forEach(function (element) {
            rules.forEach(function (rule) {
                if (!rule.force && element !== doc.body) return;
                entries.push({element: element, property: rule.property,
                    value: element.style.getPropertyValue(rule.property),
                    priority: element.style.getPropertyPriority(rule.property)});
                var value = rule.force && isProtected(element, rule.property)
                    ? doc.defaultView.getComputedStyle(element).getPropertyValue(rule.property) : rule.value;
                writes.push({element: element, property: rule.property, value: value});
            });
        });
        originals.set(doc, {entries: entries, signature: signature});
        writes.forEach(function (entry) {
            entry.element.style.setProperty(entry.property, entry.value, "important");
        });
    }

    function applyCurrent() {
        if (!initialized) return;
        reader.rendition.getContents().forEach(apply);
        updateControls();
    }

    function cancelPositionRestore(event) {
        var target = event && event.target;
        if (target && target.closest && target.closest("#settings-modal")) return;
        anchor = null;
        updateGeneration++;
        if (settleFrame !== null) cancelAnimationFrame(settleFrame);
        settleFrame = null;
    }

    function anchorVisible(position) {
        var contents = reader.rendition.getContents().find(function (item) {
            return item.sectionIndex === position.index;
        });
        if (!contents) return false;
        var point = contents.locationOf(position.cfi);
        var bounds = contents.document.defaultView.frameElement.getBoundingClientRect();
        var viewer = document.getElementById("viewer").getBoundingClientRect();
        var x = bounds.left + point.left;
        var y = bounds.top + point.top;
        return x >= viewer.left - 1 && x < viewer.right && y >= viewer.top - 1 && y < viewer.bottom;
    }

    function settlePosition(generation) {
        var lastSize = "";
        var stable = 0;
        var samples = 0;
        function check() {
            settleFrame = null;
            if (generation !== updateGeneration || !anchor) return;
            var dimensions = reader.rendition.getContents().map(function (contents) {
                var doc = contents.document;
                var frameElement = doc.defaultView && doc.defaultView.frameElement;
                if (!doc.body || !frameElement) return [];
                var rect = frameElement.getBoundingClientRect();
                return [doc.body.scrollWidth, doc.body.scrollHeight, rect.width, rect.height];
            });
            var size = JSON.stringify(dimensions);
            stable = size === lastSize ? stable + 1 : 0;
            lastSize = size;
            samples++;
            // Check actual geometry over successive rendering frames. Bound the
            // observer lifetime for books with continuously changing content.
            if (stable < 3 && samples < 120) {
                settleFrame = requestAnimationFrame(check);
                return;
            }
            var position = anchor;
            anchor = null;
            try {
                if (!anchorVisible(position)) {
                    reader.rendition.display(position.cfi).catch(function () {
                        status.textContent = root.dataset.positionError;
                    });
                }
            } catch (error) {
                status.textContent = root.dataset.positionError;
            }
        }
        settleFrame = requestAnimationFrame(check);
    }

    function schedule(preservePosition) {
        if (!initialized) return;
        // location is the last reported value. currentLocation() recalculates
        // layout and may throw before views exist; it must never gate applying styles.
        if (preservePosition !== false && !anchor) {
            var location = reader.rendition.location;
            if (location && location.start && location.start.cfi) {
                anchor = {cfi: location.start.cfi, index: location.start.index};
            }
        }
        updateGeneration++;
        if (settleFrame !== null) cancelAnimationFrame(settleFrame);
        settleFrame = null;
        // Apply synchronously: cancelling/replacing position work cannot drop
        // the latest preference change. Future chapter hooks read the same state.
        applyCurrent();
        if (anchor) settlePosition(updateGeneration);
    }

    function change(key, direction) {
        if (layoutState !== "reflowable") return;
        var spec = specs[key];
        state[key] = direction === 0 ? null : (state[key] === null ? spec.initial :
            Math.max(spec.min, Math.min(spec.max, Math.round(state[key] * spec.unit) + (direction * spec.step)))) / spec.unit;
        var patch = {};
        patch[key] = state[key];
        ReaderPreferences.set(patch);
    }

    function init() {
        if (initialized || !root) return;
        initialized = true;
        readState();
        Object.keys(specs).forEach(function (key) {
            [["Decrease", -1], ["Increase", 1], ["Reset", 0]].forEach(function (action) {
                document.getElementById(key + action[0]).addEventListener("click", function () {
                    change(key, action[1]);
                });
            });
        });
        forceControl.addEventListener("change", function () {
            ReaderPreferences.set({forceSpacing: forceControl.checked});
        });
        document.addEventListener("pointerdown", cancelPositionRestore, true);
        document.addEventListener("keydown", function (event) {
            if (["PageUp", "PageDown", "ArrowLeft", "ArrowRight"].indexOf(event.key) !== -1) cancelPositionRestore(event);
        }, true);
        reader.rendition.on("keydown", function (event) {
            if (["PageUp", "PageDown", "ArrowLeft", "ArrowRight"].indexOf(event.key) !== -1) cancelPositionRestore(event);
        });
        reader.rendition.on("touchstart", cancelPositionRestore);
        reader.rendition.hooks.content.register(function (contents) {
            contents.document.addEventListener("pointerdown", cancelPositionRestore, true);
            apply(contents);
        });
        // Layout notifications can be raised inside apply/display. Do not
        // re-enter the typography pipeline or keep rescheduling position work.
        reader.rendition.on("layout", updateControls);
        ReaderPreferences.subscribe(function () {
            schedule();
        });
        reader.rendition.on("relocated", updateControls);
        reader.book.ready.then(applyCurrent);
        applyCurrent();
    }

    return {init: init, update: schedule};
})();
