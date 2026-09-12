/* exported ReaderFonts */

// Resource-only server font loading: fetches the manifest once, registers
// FontFace objects per chapter document, and reports ready/failed back to the
// caller. Never touches book content styles, preferences, or reading position -
// that stays the exclusive responsibility of ReaderSpacing.
var ReaderFonts = (function () {
    "use strict";
    var FAMILY_PREFIX = "cw-server-";
    var LOAD_TIMEOUT_MS = 10000;

    var catalog = null;
    var catalogPromise = null;
    var registrations = new WeakMap();

    function fetchCatalog() {
        if (catalogPromise) return catalogPromise;
        catalogPromise = fetch("/reader/fonts", {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) throw new Error("font catalog request failed");
            return response.json();
        }).then(function (data) {
            var families = {};
            (data.fonts || []).forEach(function (font) {
                var faces = {};
                (font.faces || []).forEach(function (face) {
                    faces[face.id] = face;
                });
                families[font.id] = {name: font.name, fallback: font.fallback, faces: faces};
            });
            catalog = {revision: data.revision, families: families};
            return catalog;
        }).catch(function () {
            catalog = {revision: null, families: {}};
            return catalog;
        });
        return catalogPromise;
    }

    function registryFor(doc) {
        var registry = registrations.get(doc);
        if (!registry) {
            registry = new Map();
            registrations.set(doc, registry);
        }
        return registry;
    }

    function withTimeout(promise) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error("font load timed out"));
            }, LOAD_TIMEOUT_MS);
            promise.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function loadFamily(doc, fontId, family) {
        var win = doc.defaultView;
        var faceIds = Object.keys(family.faces);
        if (!faceIds.length) return Promise.reject(new Error("font family has no faces"));
        var loads = faceIds.map(function (faceId) {
            var face = family.faces[faceId];
            var fontFace = new win.FontFace(FAMILY_PREFIX + fontId, "url(" + face.url + ")",
                {weight: String(face.weight), style: face.style});
            doc.fonts.add(fontFace);
            return fontFace.load();
        });
        return withTimeout(Promise.all(loads));
    }

    // onDone receives "ready" or "failed"; never throws, never left pending.
    function ensure(doc, fontId, onDone) {
        fetchCatalog().then(function (loadedCatalog) {
            var family = loadedCatalog.families[fontId];
            if (!family) {
                onDone("failed");
                return;
            }
            var registry = registryFor(doc);
            var key = fontId + "@" + loadedCatalog.revision;
            var entry = registry.get(key);
            if (!entry) {
                entry = {promise: loadFamily(doc, fontId, family).then(function () {
                    entry.status = "ready";
                }).catch(function () {
                    entry.status = "failed";
                }), status: "pending"};
                registry.set(key, entry);
            }
            entry.promise.then(function () {
                onDone(entry.status);
            });
        });
    }

    function cssFamily(fontId) {
        return FAMILY_PREFIX + fontId;
    }

    function fallbackFor(fontId) {
        return catalog && catalog.families[fontId] && catalog.families[fontId].fallback || "serif";
    }

    function subscribeCatalog(listener) {
        fetchCatalog().then(listener);
    }

    return {ensure: ensure, cssFamily: cssFamily, fallbackFor: fallbackFor, subscribeCatalog: subscribeCatalog};
})();
