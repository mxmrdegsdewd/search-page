/*
 * Проверка орфографии — слой поверх типографа.
 *
 * Полностью в браузере: словарь Hunspell (nspell, MIT) + русский словарь
 * (BSD-3-Clause). Ничего не уходит на сервер — безопасно за рабочим VPN.
 *
 * Роли:
 *   • «Очевидные» опечатки чинит детерминированный список в typograf.js (надёжно).
 *   • Здесь — сеть безопасности на длинный хвост: находим несуществующие слова,
 *     подчёркиваем их и предлагаем замены. Слово меняется только по клику —
 *     автозамены по словарю нет (подсказки словаря не всегда точны).
 *
 * Словарь (3,5 МБ) грузится ЛЕНИВО и в фоне, чтобы не тормозить страницу.
 * После первой загрузки кешируется браузером.
 *
 * API:
 *   window.spellInit()        -> Promise  (можно вызвать заранее, в простое)
 *   window.spellReady()       -> bool
 *   window.spellCheck(text)   -> [{word, start, end, suggestions:[...]}]
 *   window.spellAddWord(word) -> добавить слово в личный словарь (перестанет подчёркиваться)
 *   window.spellKnows(word)   -> bool
 */
(function (global) {
    'use strict';

    var spell = null;       // экземпляр nspell
    var loading = null;     // Promise загрузки (чтобы не грузить дважды)
    var ready = false;

    /* ── Белый список: бренды, проф-лексикон, личные слова ──────────────
       Английские слова сюда не нужны — проверяем только кириллицу.
       Проверка идёт ПОСЛЕ словаря, только для незнакомых слов, поэтому
       основы можно брать жадно: они лишь гасят ложные подчёркивания. */

    // Основы брендов/терминов: слово проходит, если начинается с основы (≥4 букв).
    // Так ловятся все склонения: директ → директе, директа, директом…
    var STEMS = [
        'яндекс', 'директ', 'метрик', 'дзен', 'вконтакт', 'сбер', 'тинькофф',
        'озон', 'вайлдберриз', 'авито', 'телеграм', 'ватсап', 'вотсап', 'елам',
        'таргет', 'ретаргет', 'оффер', 'лидген', 'креатив', 'инсайт', 'сторис',
        'промо', 'перформанс', 'медийк', 'контекст'
    ];
    // Короткие слова и точные формы (где основа дала бы слишком много).
    var EXACT = {};
    ['лид', 'лиды', 'лидов', 'лидам', 'лидами', 'срм', 'сиэрэм', 'рилс', 'рилc']
        .forEach(function (w) { EXACT[w] = 1; });

    function loadWhitelist() {
        try {
            JSON.parse(localStorage.getItem('spell_ok') || '[]')
                .forEach(function (w) { EXACT[String(w).toLowerCase()] = 1; });
        } catch (e) { /* пусто */ }
    }
    function whitelisted(wLower) {
        if (EXACT[wLower]) return true;
        for (var s = 0; s < STEMS.length; s++) {
            if (wLower.indexOf(STEMS[s]) === 0) return true;
        }
        return false;
    }
    function addWord(word) {
        word = String(word || '').toLowerCase().trim();
        if (!word) return;
        EXACT[word] = 1;
        var arr = [];
        try { arr = JSON.parse(localStorage.getItem('spell_ok') || '[]'); } catch (e) { arr = []; }
        if (arr.indexOf(word) < 0) { arr.push(word); localStorage.setItem('spell_ok', JSON.stringify(arr)); }
    }
    loadWhitelist();

    /* ── Ленивая загрузка словаря ───────────────────────────────────── */
    function init() {
        if (loading) return loading;
        if (typeof global.nspell === 'undefined') {
            loading = Promise.reject(new Error('nspell не загружен'));
            return loading;
        }
        loading = Promise.all([
            fetch('ru.aff').then(function (r) { return r.text(); }),
            fetch('ru.dic').then(function (r) { return r.text(); })
        ]).then(function (parts) {
            spell = global.nspell(parts[0], parts[1]);
            ready = true;
            return spell;
        });
        return loading;
    }

    /* ── Проверка слова ─────────────────────────────────────────────── */
    function knows(word) {
        if (!ready) return true;            // пока не готовы — никого не трогаем
        if (spell.correct(word)) return true;
        return whitelisted(word.toLowerCase());
    }

    // Кириллическое слово, возможно с дефисом (что-то, по-новому).
    var WORD_RE = /[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/g;

    function check(text) {
        if (!ready || !text) return [];
        var issues = [], m;
        WORD_RE.lastIndex = 0;
        while ((m = WORD_RE.exec(text))) {
            var w = m[0];
            if (w.length < 3) continue;               // короткие не трогаем
            if (/[А-ЯЁ]{2,}/.test(w)) continue;       // аббревиатуры (ВВП, США)
            if (spell.correct(w)) continue;           // словарь знает слово
            if (whitelisted(w.toLowerCase())) continue; // бренд / личное слово
            issues.push({
                word: w,
                start: m.index,
                end: m.index + w.length,
                suggestions: spell.suggest(w).slice(0, 6)
            });
        }
        return issues;
    }

    global.spellInit = init;
    global.spellReady = function () { return ready; };
    global.spellCheck = check;
    global.spellAddWord = addWord;
    global.spellKnows = knows;
})(typeof globalThis !== 'undefined' ? globalThis : this);
