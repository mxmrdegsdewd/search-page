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

    /* ── Клавиатурная близость (ЙЦУКЕН) для ранжирования подсказок ──── */
    // Раскладка: координаты [row, col] каждой буквы.
    var KB = (function () {
        var rows = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
        var map = {};
        rows.forEach(function (row, r) {
            row.split('').forEach(function (ch, c) { map[ch] = [r, c * 1.1]; }); // 1.1 — смещение строк
        });
        return map;
    }());

    function kbDist(a, b) {
        var pa = KB[a.toLowerCase()], pb = KB[b.toLowerCase()];
        if (!pa || !pb) return 3;                  // неизвестный символ — большое расстояние
        var dr = pa[0] - pb[0], dc = pa[1] - pb[1];
        return Math.sqrt(dr * dr + dc * dc);
    }

    // Оценка подсказки: сумма расстояний между символами.
    // Чем ниже score, тем ближе подсказка к слову по клавиатуре.
    function suggScore(word, sugg) {
        var wl = word.toLowerCase(), sl = sugg.toLowerCase();
        // Разная длина — бонус за похожую длину, штраф за большую разницу
        var lenPenalty = Math.abs(wl.length - sl.length) * 2;
        if (lenPenalty > 6) return 100;
        // Выравниваем до общей длины для посимвольного сравнения
        var len = Math.min(wl.length, sl.length), s = lenPenalty;
        for (var i = 0; i < len; i++) s += kbDist(wl[i], sl[i]);
        // Штраф за заглавную букву в подсказке (имена собственные менее вероятны)
        if (/^[А-ЯЁ]/.test(sugg) && !/^[А-ЯЁ]/.test(word)) s += 5;
        return s;
    }

    function rankSuggestions(word, suggs) {
        return suggs.slice().sort(function (a, b) {
            return suggScore(word, a) - suggScore(word, b);
        });
    }

    /* ── Детектор слипшихся слов ─────────────────────────────────────── */
    // «двасобаки» → «два собаки». Проверяем все точки разреза от 2 до len-2.
    function trySplit(word) {
        var wl = word.toLowerCase();
        for (var i = 2; i <= wl.length - 2; i++) {
            var left = wl.slice(0, i), right = wl.slice(i);
            if (left.length < 2 || right.length < 2) continue;
            if (spell.correct(left) && spell.correct(right)) {
                // восстанавливаем заглавную первого слова
                var res = (/^[А-ЯЁ]/.test(word) ? left.charAt(0).toUpperCase() + left.slice(1) : left) + ' ' + right;
                return [res];
            }
        }
        return [];
    }

    /* ── Управление личным словарём ──────────────────────────────────── */
    function getPersonalWords() {
        try { return JSON.parse(localStorage.getItem('spell_ok') || '[]'); } catch (e) { return []; }
    }
    function removeWord(word) {
        word = String(word || '').toLowerCase().trim();
        delete EXACT[word];
        var arr = getPersonalWords().filter(function (w) { return w !== word; });
        localStorage.setItem('spell_ok', JSON.stringify(arr));
    }

    /* ── Проверка слова ─────────────────────────────────────────────── */
    function knows(word) {
        if (!ready) return true;
        if (spell.correct(word)) return true;
        return whitelisted(word.toLowerCase());
    }

    // Кириллическое слово, возможно с дефисом (что-то, по-новому).
    var WORD_RE = /[А-Яа-яЁё]+(?:[‑\-][А-Яа-яЁё]+)*/g;

    function check(text) {
        if (!ready || !text) return [];
        var issues = [], m;
        WORD_RE.lastIndex = 0;
        while ((m = WORD_RE.exec(text))) {
            var w = m[0];
            if (w.length < 3) continue;
            if (/[А-ЯЁ]{2,}/.test(w)) continue;       // аббревиатуры
            if (spell.correct(w)) continue;
            if (whitelisted(w.toLowerCase())) continue;

            // Пытаемся разрезать слипшееся слово
            var splitSugg = trySplit(w);
            // Подсказки словаря, отсортированные по клавиатурной близости
            var dictSugg = rankSuggestions(w, spell.suggest(w)).slice(0, 5);
            var suggs = splitSugg.concat(dictSugg).slice(0, 6);

            issues.push({
                word: w,
                start: m.index,
                end: m.index + w.length,
                suggestions: suggs,
                isMerged: splitSugg.length > 0 && dictSugg.length === 0
            });
        }
        return issues;
    }

    global.spellInit = init;
    global.spellReady = function () { return ready; };
    global.spellCheck = check;
    global.spellAddWord = addWord;
    global.spellRemoveWord = removeWord;
    global.spellGetPersonal = getPersonalWords;
    global.spellKnows = knows;
})(typeof globalThis !== 'undefined' ? globalThis : this);
