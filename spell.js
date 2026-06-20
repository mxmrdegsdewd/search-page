/*
 * Проверка орфографии — главный поток.
 * Вся тяжёлая работа (загрузка словаря, построение индекса, проверка)
 * выполняется в spell-worker.js (Web Worker) — главный поток не блокируется.
 *
 * API:
 *   window.spellInit()              -> Promise  (запустить загрузку)
 *   window.spellReady()             -> bool
 *   window.spellCheck(text)         -> Promise<[{word,start,end,suggestions}]>
 *   window.spellAddWord(word)       -> void
 *   window.spellRemoveWord(word)    -> void
 *   window.spellGetPersonal()       -> string[]
 */
(function (global) {
    'use strict';

    var worker = null;
    var loading = null;
    var ready = false;
    var pending = {};   // id → resolve
    var callId = 0;

    /* ── Личный словарь (хранится в localStorage) ─────────────────── */
    function getPersonalWords() {
        try { return JSON.parse(localStorage.getItem('spell_ok') || '[]'); } catch (e) { return []; }
    }
    function addWord(word) {
        word = String(word || '').toLowerCase().trim();
        if (!word) return;
        var arr = getPersonalWords();
        if (arr.indexOf(word) < 0) { arr.push(word); localStorage.setItem('spell_ok', JSON.stringify(arr)); }
        if (worker) worker.postMessage({ type: 'addWord', word: word });
    }
    function removeWord(word) {
        word = String(word || '').toLowerCase().trim();
        if (!word) return;
        var arr = getPersonalWords().filter(function (w) { return w !== word; });
        localStorage.setItem('spell_ok', JSON.stringify(arr));
        if (worker) worker.postMessage({ type: 'removeWord', word: word });
    }

    /* ── Запуск воркера ─────────────────────────────────────────────── */
    function init() {
        if (loading) return loading;
        if (typeof Worker === 'undefined') {
            loading = Promise.reject(new Error('Worker not supported'));
            return loading;
        }
        loading = new Promise(function (resolve, reject) {
            worker = new Worker('spell-worker.js');
            worker.onmessage = function (e) {
                var msg = e.data;
                if (msg.type === 'ready') {
                    ready = true;
                    // синхронизируем личный словарь
                    worker.postMessage({ type: 'setPersonal', words: getPersonalWords() });
                    resolve();
                } else if (msg.type === 'checked') {
                    var cb = pending[msg.id];
                    if (cb) { delete pending[msg.id]; cb(msg.issues); }
                } else if (msg.type === 'error') {
                    reject(new Error(msg.msg));
                }
            };
            worker.onerror = function (e) { reject(e); };
            worker.postMessage({ type: 'init' });
        });
        return loading;
    }

    /* ── Проверка текста (асинхронная) ─────────────────────────────── */
    function check(text) {
        if (!ready || !text) return Promise.resolve([]);
        return new Promise(function (resolve) {
            var id = ++callId;
            pending[id] = resolve;
            worker.postMessage({ type: 'check', id: id, text: text });
            // страховка: если воркер завис — вернуть пустой результат
            setTimeout(function () {
                if (pending[id]) { delete pending[id]; resolve([]); }
            }, 8000);
        });
    }

    global.spellInit = init;
    global.spellReady = function () { return ready; };
    global.spellCheck = check;
    global.spellAddWord = addWord;
    global.spellRemoveWord = removeWord;
    global.spellGetPersonal = getPersonalWords;
})(typeof globalThis !== 'undefined' ? globalThis : this);
