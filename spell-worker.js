/*
 * Web Worker для проверки орфографии.
 * Работает в отдельном потоке — главный поток (UI, ввод) не блокируется
 * даже во время загрузки и сборки индекса словаря (~1 сек).
 *
 * Протокол (postMessage):
 *   → {type:'init'}                          начать загрузку словаря
 *   → {type:'check', id, text}               проверить текст
 *   → {type:'addWord', word}                 добавить в личный словарь
 *   → {type:'removeWord', word}              удалить из личного словаря
 *   → {type:'setPersonal', words:[]}         синхронизировать весь личный словарь
 *   ← {type:'ready'}                         индекс готов
 *   ← {type:'checked', id, issues:[]}        результат проверки
 *   ← {type:'error', msg}                    ошибка загрузки
 */
importScripts('nspell.js');

var sp = null;

/* ── Белый список (дублируется из spell.js, работает в воркере) ── */
var STEMS = [
    'яндекс', 'директ', 'метрик', 'дзен', 'вконтакт', 'сбер', 'тинькофф',
    'озон', 'вайлдберриз', 'авито', 'телеграм', 'ватсап', 'вотсап', 'елам',
    'таргет', 'ретаргет', 'оффер', 'лидген', 'креатив', 'инсайт', 'сторис',
    'промо', 'перформанс', 'медийк', 'контекст'
];
var EXACT = {};
['лид', 'лиды', 'лидов', 'лидам', 'лидами', 'срм', 'сиэрэм', 'рилс']
    .forEach(function (w) { EXACT[w] = 1; });

function whitelisted(w) {
    if (EXACT[w]) return true;
    for (var i = 0; i < STEMS.length; i++) {
        if (w.indexOf(STEMS[i]) === 0) return true;
    }
    return false;
}

/* ── Клавиатурная близость (ЙЦУКЕН) ── */
var KB = (function () {
    var rows = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
    var map = {};
    rows.forEach(function (row, r) {
        row.split('').forEach(function (ch, c) { map[ch] = [r, c * 1.1]; });
    });
    return map;
}());

function kbDist(a, b) {
    var pa = KB[a.toLowerCase()], pb = KB[b.toLowerCase()];
    if (!pa || !pb) return 3;
    var dr = pa[0] - pb[0], dc = pa[1] - pb[1];
    return Math.sqrt(dr * dr + dc * dc);
}

function suggScore(word, sugg) {
    var wl = word.toLowerCase(), sl = sugg.toLowerCase();
    var lenPenalty = Math.abs(wl.length - sl.length) * 2;
    if (lenPenalty > 6) return 100;
    var len = Math.min(wl.length, sl.length), s = lenPenalty;
    for (var i = 0; i < len; i++) s += kbDist(wl[i], sl[i]);
    if (/^[А-ЯЁ]/.test(sugg) && !/^[А-ЯЁ]/.test(word)) s += 5;
    return s;
}

function rankSuggestions(word, suggs) {
    return suggs.slice().sort(function (a, b) {
        return suggScore(word, a) - suggScore(word, b);
    });
}

/* ── Детектор слипшихся слов ── */
function trySplit(word) {
    var wl = word.toLowerCase();
    for (var i = 2; i <= wl.length - 2; i++) {
        var left = wl.slice(0, i), right = wl.slice(i);
        if (left.length < 2 || right.length < 2) continue;
        if (sp.correct(left) && sp.correct(right)) {
            var res = (/^[А-ЯЁ]/.test(word)
                ? left.charAt(0).toUpperCase() + left.slice(1)
                : left) + ' ' + right;
            return [res];
        }
    }
    return [];
}

/* ── Проверка текста ── */
var WORD_RE = /[А-Яа-яЁё]+(?:[‑\-][А-Яа-яЁё]+)*/g;

function doCheck(text) {
    if (!sp || !text) return [];
    var issues = [], m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
        var w = m[0];
        if (w.length < 3) continue;
        if (/[А-ЯЁ]{2,}/.test(w)) continue;
        if (sp.correct(w)) continue;
        if (whitelisted(w.toLowerCase())) continue;
        var splitSugg = trySplit(w);
        var dictSugg = rankSuggestions(w, sp.suggest(w)).slice(0, 5);
        var suggs = splitSugg.concat(dictSugg).slice(0, 6);
        issues.push({ word: w, start: m.index, end: m.index + w.length, suggestions: suggs });
    }
    return issues;
}

/* ── Обработчик сообщений ── */
self.onmessage = function (e) {
    var msg = e.data;
    switch (msg.type) {
        case 'init':
            Promise.all([
                fetch('ru.aff').then(function (r) { return r.text(); }),
                fetch('ru.dic').then(function (r) { return r.text(); })
            ]).then(function (parts) {
                sp = self.nspell(parts[0], parts[1]);
                self.postMessage({ type: 'ready' });
            }).catch(function (err) {
                self.postMessage({ type: 'error', msg: String(err) });
            });
            break;
        case 'check':
            self.postMessage({ type: 'checked', id: msg.id, issues: doCheck(msg.text) });
            break;
        case 'addWord':
            EXACT[String(msg.word).toLowerCase()] = 1;
            break;
        case 'removeWord':
            delete EXACT[String(msg.word).toLowerCase()];
            break;
        case 'setPersonal':
            (msg.words || []).forEach(function (w) { EXACT[String(w).toLowerCase()] = 1; });
            break;
    }
};
