// Run with: node --test test/reader_preferences.test.cjs
// No browser or external dependencies. These checks do not validate rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../cps/static/js/reading/', name), 'utf8');
function load(book, storage = new Map(), denied = false) {
    const sandbox = {window: {calibre: {bookUrl: book}}, localStorage: {
        getItem(key) { if (denied) throw Error('denied'); return storage.get(key) ?? null; },
        setItem(key, value) { if (denied) throw Error('denied'); storage.set(key, String(value)); }
    }};
    vm.createContext(sandbox);
    vm.runInContext(source('reader_preferences.js'), sandbox);
    return {context: sandbox, prefs: sandbox.ReaderPreferences, storage};
}
const plain = value => JSON.parse(JSON.stringify(value));
function vendor() {
    return {settings: {bookKey: 'epubjsreader:runtime:book', sidebarReflow: true,
        styles: {fontSize: '120%', other: 'keep'}, bookmarks: ['bookmark'], annotations: ['note'], previousLocationCfi: 'keep-cfi'},
        rendition: {currentLocation() { throw Error('not ready'); }}};
}
test('legacy import, complete snapshot, book isolation and reset persist without modifying global keys', () => {
    const store = new Map([
        ['calibre.reader.font', 'KaiTi'], ['calibre.reader.fontSize', '140'], ['calibre.reader.theme', 'darkTheme'],
        ['calibre.reader.spacing.v1./a', JSON.stringify({version: 1, lineHeight: 1.8, letterSpacing: 0, force: true})]
    ]);
    const {prefs} = load('/a', store); prefs.attach(vendor());
    assert.equal(prefs.get().sidebarReflow, true); assert.equal(prefs.get().letterSpacing, 0);
    prefs.set({font: 'Arial', spread: 'none'});
    assert.equal(load('/a', store).prefs.get().spread, 'none');
    assert.equal(load('/b', store).prefs.get().font, 'KaiTi');
    prefs.reset(); const reopened = load('/a', store).prefs.get();
    assert.equal(reopened.theme, 'lightTheme'); assert.equal(reopened.fontSize, 100);
    assert.equal(reopened.forceSpacing, false); assert.equal(reopened.sidebarReflow, false);
    prefs.set({lineHeight: 1.6}); assert.equal(prefs.get().forceSpacing, false);
    assert.equal(store.get('calibre.reader.theme'), 'darkTheme');
});
test('vendor reset updates memory and storage without deleting bookmarks/position/unknown fields', () => {
    const v = vendor(), store = new Map([[v.settings.bookKey, JSON.stringify({...v.settings, unknown: 42})]]);
    const {prefs} = load('/a', store); prefs.attach(v);
    assert.equal(prefs.get().fontSize, 120); prefs.reset();
    assert.equal(v.settings.sidebarReflow, false); assert.equal(v.settings.styles.fontSize, '100%');
    let stored = JSON.parse(store.get(v.settings.bookKey));
    assert.deepEqual(stored.bookmarks, ['bookmark']); assert.equal(stored.unknown, 42);
    assert.equal(stored.previousLocationCfi, 'keep-cfi');
    assert.doesNotThrow(() => v.saveSettings());
    stored = JSON.parse(store.get(v.settings.bookKey));
    assert.equal(stored.sidebarReflow, false); assert.equal(stored.styles.fontSize, '100%');
    assert.deepEqual(stored.annotations, ['note']); assert.equal(stored.previousLocationCfi, 'keep-cfi'); assert.equal(stored.unknown, 42);
});
test('corrupt snapshots never reimport legacy values, validation and denied storage remain usable', () => {
    for (const raw of ['broken', '{"version":99}', '{"version":1,"fontSize":72,"letterSpacing":0.03}']) {
        const {prefs} = load('/a', new Map([['calibre.reader.preferences.v1./a', raw], ['calibre.reader.font', 'Arial']]));
        assert.equal(prefs.get().font, 'default'); assert.equal(prefs.get().fontSize, 100);
        assert.equal(prefs.get().letterSpacing, null);
    }
    const {prefs} = load('/a', new Map(), true);
    prefs.set({font: 'Arial', lineHeight: 1.8, letterSpacing: 0, customTheme: 'url(evil)'});
    assert.equal(prefs.get().font, 'Arial'); assert.equal(prefs.get().letterSpacing, 0);
    assert.equal(prefs.get().customTheme, '#ffffff'); assert.equal(prefs.failed(), true);
});
function spacingHarness() {
    const loaded = load('/a');
    const nodes = new Map(), hooks = [], events = {}, frames = new Map(); let next = 0;
    function node() { return {dataset: {original: 'Original', reflowable: 'ready', pending: 'loading', fixed: 'fixed'},
        addEventListener(type, cb) { this[type] = cb; }}; }
    const document = {getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
        addEventListener() {}, dispatchEvent() {}};
    function element(value, protectedElement = false) {
        const values = new Map(value ? [['line-height', value]] : []), priorities = new Map(value ? [['line-height', 'important']] : []);
        return {nodeType: 1, parentElement: null, closest() { return protectedElement; }, matches() { return false; },
            getAttribute() { return ''; }, getAttributeNS() { return ''; },
            style: {getPropertyValue(k) { return values.get(k) || ''; }, getPropertyPriority(k) { return priorities.get(k) || ''; },
                setProperty(k,v,p) { values.set(k,v); priorities.set(k,p); }, removeProperty(k) { values.delete(k); priorities.delete(k); }}};
    }
    function chapter() {
        const p = element('1.1'), code = element('1.2', true), body = element('1.3');
        body.querySelectorAll = () => [p, code];
        const doc = {body, addEventListener() {}, defaultView: {getComputedStyle(el) { return {getPropertyValue(k) { return el.style.getPropertyValue(k) || 'normal'; }}; }}};
        return {document: doc, sectionIndex: 0, p, code};
    }
    const first = chapter(); let contents = [first], layout = 'reflowable';
    const reader = {book: {spine: {spineItems: [], get() { return {properties: []}; }}, ready: {then(cb) { cb(); }}},
        rendition: {location: null, currentLocation() { throw Error('not ready'); }, layout() { throw Error("layout() mutates rendering; never call it to inspect state"); },
            manager: {get layout() { return {name: layout}; }},
            getContents() { return contents; }, on(name,cb) { events[name] = cb; }, hooks: {content: {register(cb) { hooks.push(cb); }}}}};
    Object.assign(loaded.context, {reader, document, WeakMap, Event: function() {},
        requestAnimationFrame(cb) { frames.set(++next,cb); return next; }, cancelAnimationFrame(id) { frames.delete(id); }});
    vm.runInContext(source('reader_spacing.js'), loaded.context);
    loaded.context.ReaderSpacing.init();
    return {...loaded, first, hooks, nodes, events, frames, chapter,
        setContents(value) { contents = value; }, fixed() { layout = 'pre-paginated'; }};
}
test('typography applies even with throwing currentLocation; latest of 100 rapid updates wins', () => {
    const h = spacingHarness();
    for (let i=0;i<100;i++) h.prefs.set({lineHeight: i%2 ? 2.2 : 1.2, letterSpacing: i%2 ? 0.2 : 0, forceSpacing: true});
    assert.equal(h.first.p.style.getPropertyValue('line-height'), '2.2');
    assert.equal(h.first.p.style.getPropertyValue('letter-spacing'), '0.2em');
    assert.equal(h.first.code.style.getPropertyValue('line-height'), '1.2');
    assert.equal(h.frames.size, 0); // no anchor available, no position job needed
    h.prefs.reset(); assert.equal(h.first.p.style.getPropertyValue('line-height'), '1.1');
    assert.equal(h.first.p.style.getPropertyPriority('line-height'), 'important');
    assert.equal(h.first.p.style.getPropertyValue('letter-spacing'), '');
});
test('future chapters use latest settings, fixed layout stops spacing but preserves font', () => {
    const h = spacingHarness();
    h.prefs.set({font: 'Arial', forceFont: true, lineHeight: 1.8, forceSpacing: true});
    const second = h.chapter(); h.setContents([second]); h.hooks.forEach(fn => fn(second));
    assert.equal(second.p.style.getPropertyValue('line-height'), '1.8');
    h.fixed(); h.prefs.set({letterSpacing: 0.1});
    assert.equal(second.p.style.getPropertyValue('line-height'), '1.1');
    assert.equal(second.p.style.getPropertyValue('font-family'), 'Arial, sans-serif');
    assert.equal(h.nodes.get('forceSpacingOverride').disabled, true);
});
test('settings key guard blocks vendor arrows, supports tabs and leaves editing defaults intact', () => {
    const text = source('reader_settings.js');
    const start = text.indexOf('    function guardKeys(event)');
    const end = text.indexOf('    document.addEventListener("keydown", guardKeys', start);
    const tabs = [{}, {}, {}]; let visible = true, selected = null, closed = false;
    const context = {open: () => visible, tabs, chooseTab: tab => {selected = tab;}, close: () => {closed = true;}};
    vm.createContext(context); vm.runInContext(text.slice(start, end), context);
    function event(key, target) {return {key, target, preventDefault() {this.prevented = true;}, stopImmediatePropagation() {this.stopped = true;}};}
    const right = event('ArrowRight', tabs[0]);context.guardKeys(right);
    assert.equal(selected, tabs[1]);assert.equal(right.stopped, true);assert.equal(right.prevented, true);
    const endKey = event('End', tabs[0]);context.guardKeys(endKey);assert.equal(selected, tabs[2]);
    const editing = event('ArrowLeft', {});context.guardKeys(editing);assert.equal(editing.stopped, true);assert.equal(editing.prevented, undefined);
    const down = event('PageDown', {});context.guardKeys(down);assert.equal(down.stopped, true);
    context.guardKeys(event('Escape', {}));assert.equal(closed, true);
    visible = false;const normal = event('ArrowRight', {});context.guardKeys(normal);assert.equal(normal.stopped, undefined);
});
test('layout notifications only inspect state and do not re-enter the layout mutator', () => {
    const h = spacingHarness();
    for (let i = 0; i < 20; i++) h.events.layout();
    assert.equal(h.nodes.get('forceSpacingOverride').disabled, true);
    h.prefs.set({lineHeight: 1.6, forceSpacing: true});
    h.events.layout();
    assert.equal(h.first.p.style.getPropertyValue('line-height'), '1.6');
    assert.equal(h.nodes.get('forceSpacingOverride').disabled, false);
});
